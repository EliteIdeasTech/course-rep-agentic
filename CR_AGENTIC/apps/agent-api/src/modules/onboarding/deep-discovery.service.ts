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
import { LoginService } from './login.service';
import { ApplyResultsRequestDto } from './dto/onboarding.request.dto';

@Injectable()
export class DeepDiscoveryService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly onboarding: OnboardingService,
    private readonly login: LoginService,
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
      courses,
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

  /** Records the user's import selections and completes onboarding. */
  async applyResults(userId: string, sessionId: string, dto: ApplyResultsRequestDto) {
    const claimed = await this.login.ensureClaimedIdentity(userId, sessionId);
    const actorId = claimed.userId;
    const session = await this.onboarding.requireSession(actorId, sessionId);

    if (dto.courseIds) {
      await prisma.discoveredCourse.updateMany({
        where: { onboardingSessionId: sessionId },
        data: { selected: false },
      });
      await prisma.discoveredCourse.updateMany({
        where: { onboardingSessionId: sessionId, id: { in: dto.courseIds } },
        data: { selected: true },
      });
    }

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

    await writeAuditLog({
      actorId,
      action: 'onboarding_results_applied',
      resourceType: 'onboarding_session',
      resourceId: sessionId,
      metadata: {
        courses: dto.courseIds?.length ?? 0,
        assignments: dto.assignmentIds?.length ?? 0,
        timetableSlots: dto.timetableSlotIds?.length ?? 0,
        calendarEvents: dto.calendarEventIds?.length ?? 0,
      },
    });

    return { stage: 'ONBOARDING_COMPLETE' };
  }
}
