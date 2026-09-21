import {
  BadRequestException,
  Inject,
  Injectable,
} from '@nestjs/common';
import Redis from 'ioredis';
import { prisma } from '@cr-agentic/database';
import { enqueueJob } from '@cr-agentic/queue';
import { QUEUE_NAMES } from '@cr-agentic/shared';
import type { DiscoveryDeepScrapeJob } from '@cr-agentic/shared';
import { writeAuditLog } from '@cr-agentic/observability';
import { REDIS_CLIENT } from '../queue/queue.module';
import { OnboardingService } from './onboarding.service';
import {
  orderDiscoveredCourses,
  planCourseOffering,
} from '../../integrations/course-rep/course-offering.selection';
import { annotateOffered } from '../../integrations/course-rep/import-courses.payload';
import {
  ApplyResultsRequestDto,
  CourseImportSelectionDto,
} from './dto/onboarding.request.dto';

@Injectable()
export class DeepDiscoveryService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly onboarding: OnboardingService,
  ) {}

  /** Starts the sequential deep-scrape pipeline once a session has been captured. */
  async start(userId: string, sessionId: string) {
    const session = await this.onboarding.requireSession(userId, sessionId);
    if (session.stage !== 'SESSION_CAPTURED' && session.stage !== 'DEEP_DISCOVERY') {
      throw new BadRequestException(
        `Cannot start deep discovery from stage ${session.stage}`,
      );
    }

    const account = await prisma.connectedAccount.findFirst({
      where: { onboardingSessionId: sessionId },
      orderBy: { createdAt: 'desc' },
    });
    if (!account) throw new BadRequestException('No connected account for session');

    if (session.stage === 'SESSION_CAPTURED') {
      await this.onboarding.transition(sessionId, session.stage, 'DEEP_DISCOVERY');
    }
    await prisma.connectedAccount.update({
      where: { id: account.id },
      data: { discoveryStatus: 'IN_PROGRESS' },
    });

    // The worker chains profile -> courses -> assignments -> timetable.
    await enqueueJob<DiscoveryDeepScrapeJob>(
      QUEUE_NAMES.DISCOVERY_DEEP_SCRAPE,
      this.redis,
      'deep-scrape',
      {
        onboardingSessionId: sessionId,
        connectedAccountId: account.id,
        userId,
        phase: 'profile',
      },
    );

    return { stage: 'DEEP_DISCOVERY', discoveryStatus: 'IN_PROGRESS' };
  }

  async results(userId: string, sessionId: string) {
    await this.onboarding.requireSession(userId, sessionId);
    const safeMany = async <T>(fn: () => Promise<T[]>) => {
      try {
        return await fn();
      } catch {
        return [] as T[];
      }
    };
    const safeOne = async <T>(fn: () => Promise<T | null>) => {
      try {
        return await fn();
      } catch {
        return null;
      }
    };

    const [courses, assignments, timetableSlots, academicRecords, calendarEvents, portalProfile] =
      await Promise.all([
        safeMany(() =>
          prisma.discoveredCourse.findMany({
            where: { onboardingSessionId: sessionId },
            orderBy: { code: 'asc' },
          }),
        ),
        safeMany(() =>
          prisma.discoveredAssignment.findMany({
            where: { onboardingSessionId: sessionId },
            orderBy: { dueAt: 'asc' },
          }),
        ),
        safeMany(() =>
          prisma.discoveredTimetableSlot.findMany({
            where: { onboardingSessionId: sessionId },
            orderBy: { dayOfWeek: 'asc' },
          }),
        ),
        safeMany(() =>
          prisma.discoveredAcademicRecord.findMany({
            where: { onboardingSessionId: sessionId },
          }),
        ),
        safeMany(() =>
          prisma.discoveredCalendarEvent.findMany({
            where: { onboardingSessionId: sessionId },
            orderBy: { startsAt: 'asc' },
          }),
        ),
        safeOne(() =>
          prisma.discoveredPortalProfile.findUnique({
            where: { onboardingSessionId: sessionId },
          }),
        ),
      ]);

    return {
      // Full scrape. `selected` / `offered` mark the subset the student offers.
      // Unselected rows stay here so sync can upsert them as unoffered.
      courses: courses.map((course) => annotateOffered(course)),
      assignments,
      timetableSlots,
      academicRecords,
      calendarEvents,
      portalProfile,
      discoveryStatus: (
        await prisma.connectedAccount.findFirst({
          where: { onboardingSessionId: sessionId },
          orderBy: { createdAt: 'desc' },
          select: { discoveryStatus: true },
        }).catch(() => null)
      )?.discoveryStatus ?? null,
    };
  }

  /**
   * Stores the full discovered course list and marks `selected` only for the
   * offered subset. Sync reads those flags when it upserts the catalog.
   */
  async persistCourseOffering(
    userId: string,
    sessionId: string,
    selection: CourseImportSelectionDto,
  ) {
    const existing = await prisma.discoveredCourse.findMany({
      where: { onboardingSessionId: sessionId },
      select: { id: true, code: true },
    });
    const plan = planCourseOffering(existing, selection);
    if (!plan.apply) return plan;

    if (plan.missingIds.length > 0) {
      const selectedById = new Map(plan.updates.map((row) => [row.id, row.selected]));
      await prisma.discoveredCourse.createMany({
        data: plan.missingIds.map((id) => ({
          id,
          onboardingSessionId: sessionId,
          userId,
          externalId: id,
          title: 'Discovered course',
          selected: selectedById.get(id) ?? false,
        })),
      });
    }

    await prisma.discoveredCourse.updateMany({
      where: { onboardingSessionId: sessionId },
      data: { selected: false },
    });
    const offeredIds = plan.updates.filter((row) => row.selected).map((row) => row.id);
    if (offeredIds.length > 0) {
      await prisma.discoveredCourse.updateMany({
        where: { onboardingSessionId: sessionId, id: { in: offeredIds } },
        data: { selected: true },
      });
    }
    return plan;
  }

  /**
   * Records which scraped courses the student wants to offer.
   * Unselected courses stay on the session (`selected: false`) so sync can
   * upsert the full catalog and leave those rows unoffered.
   */
  async applyResults(userId: string, sessionId: string, dto: ApplyResultsRequestDto) {
    const session = await this.onboarding.requireSession(userId, sessionId);

    const coursePlan = await this.persistCourseOffering(userId, sessionId, dto);

    if (dto.assignmentIds) {
      await prisma.discoveredAssignment.updateMany({
        where: { onboardingSessionId: sessionId },
        data: { selected: false },
      });
      await prisma.discoveredAssignment.updateMany({
        where: { onboardingSessionId: sessionId, id: { in: dto.assignmentIds } },
        data: { selected: true },
      });
    }

    if (dto.timetableSlotIds) {
      await prisma.discoveredTimetableSlot.updateMany({
        where: { onboardingSessionId: sessionId },
        data: { selected: false },
      });
      await prisma.discoveredTimetableSlot.updateMany({
        where: { onboardingSessionId: sessionId, id: { in: dto.timetableSlotIds } },
        data: { selected: true },
      });
    }

    if (dto.calendarEventIds) {
      await prisma.discoveredCalendarEvent.updateMany({
        where: { onboardingSessionId: sessionId },
        data: { selected: false },
      });
      await prisma.discoveredCalendarEvent.updateMany({
        where: { onboardingSessionId: sessionId, id: { in: dto.calendarEventIds } },
        data: { selected: true },
      });
    }

    if (session.stage === 'DEEP_DISCOVERY') {
      await this.onboarding.transition(sessionId, session.stage, 'ONBOARDING_COMPLETE');
    }

    await prisma.connectedAccount.updateMany({
      where: { onboardingSessionId: sessionId },
      data: { discoveryStatus: 'COMPLETE' },
    });

    const courses = orderDiscoveredCourses(
      await prisma.discoveredCourse.findMany({
        where: { onboardingSessionId: sessionId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      dto.courseIds,
    ).map((course) => annotateOffered(course));
    const offeredCourseCount = courses.filter((course) => course.offered).length;

    await writeAuditLog({
      actorId: userId,
      action: 'onboarding_results_applied',
      resourceType: 'onboarding_session',
      resourceId: sessionId,
      metadata: {
        courses: dto.courseIds?.length ?? 0,
        offeredCourseIds: dto.offeredCourseIds?.length ?? 0,
        offeredCodes: dto.offeredCodes?.length ?? 0,
        courseSelectionApplied: coursePlan.apply,
        discoveredCourses: courses.length,
        offeredCourses: offeredCourseCount,
        assignments: dto.assignmentIds?.length ?? 0,
        timetableSlots: dto.timetableSlotIds?.length ?? 0,
        calendarEvents: dto.calendarEventIds?.length ?? 0,
      },
    });

    return {
      stage: 'ONBOARDING_COMPLETE' as const,
      courses,
      discoveredCourseCount: courses.length,
      offeredCourseCount,
    };
  }
}
