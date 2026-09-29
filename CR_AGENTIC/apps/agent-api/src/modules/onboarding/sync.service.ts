import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { prisma } from '@cr-agentic/database';
import { writeAuditLog } from '@cr-agentic/observability';
import { CourseRepClient } from '../../integrations/course-rep/course-rep.client';
import { OnboardingService } from './onboarding.service';
import { LoginService } from './login.service';
import { courseRepUserIdForSync } from './onboarding-identity';

const EVENT_CONCURRENCY = 8;
/** Leave headroom under Cloudflare's ~100s proxy limit. */
const EVENT_BUDGET_MS = 70_000;

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly courseRep: CourseRepClient,
    private readonly onboarding: OnboardingService,
    private readonly login: LoginService,
  ) {}

  /**
   * Pushes the user's selected discovered courses, assignments, timetable slots,
   * and calendar events to the main Course Rep API.
   *
   * Always imports as the claimed Course Rep userId — never the provisional
   * guest UUID. If mobile skipped/swallowed claim-identity, we claim here.
   */
  async syncToCourseRep(userId: string, sessionId: string) {
    const claimed = await this.login.ensureClaimedIdentity(userId, sessionId);
    const session = await this.onboarding.requireSession(claimed.userId, sessionId);
    const courseRepUserId = courseRepUserIdForSync(session);

    const courses = await prisma.discoveredCourse.findMany({
      where: { onboardingSessionId: sessionId, selected: true },
    });
    const assignments = await prisma.discoveredAssignment.findMany({
      where: { onboardingSessionId: sessionId, selected: true },
    });
    const timetableSlots = await prisma.discoveredTimetableSlot.findMany({
      where: { onboardingSessionId: sessionId, selected: true },
    });
    const calendarEvents = await prisma.discoveredCalendarEvent.findMany({
      where: { onboardingSessionId: sessionId, selected: true },
    });

    let importedCourses = 0;

    if (courses.length > 0) {
      let result: { imported: number };
      try {
        result = await this.courseRep.importCourses({
          userId: courseRepUserId,
          courses: courses.map((c) => ({
            code: c.code ?? c.externalId ?? c.title,
            title: c.title,
            units: c.units ?? undefined,
            instructor: c.instructor ?? undefined,
          })),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Course import failed';
        throw new BadGatewayException(msg);
      }
      importedCourses = result.imported;

      await prisma.discoveredCourse.updateMany({
        where: { onboardingSessionId: sessionId, selected: true },
        data: { syncedAt: new Date() },
      });
    }

    type EventJob = { kind: 'assignment' | 'timetable' | 'calendar'; run: () => Promise<void> };
    const jobs: EventJob[] = [];

    for (const assignment of assignments) {
      jobs.push({
        kind: 'assignment',
        run: async () => {
          await this.courseRep.createStudyPlanEvent({
            userId: courseRepUserId,
            type: this.mapAssignmentType(assignment.eventType),
            title: assignment.title,
            dueAt: assignment.dueAt ?? undefined,
            startsAt: assignment.dueAt ?? undefined,
          });
        },
      });
    }

    for (const slot of timetableSlots) {
      jobs.push({
        kind: 'timetable',
        run: async () => {
          try {
            await this.courseRep.createStudyPlanEvent({
              userId: courseRepUserId,
              type: 'class_session',
              title: slot.title,
              startsAt: slot.startsAt ?? undefined,
              endsAt: slot.endsAt ?? undefined,
              metadata: {
                dayOfWeek: slot.dayOfWeek,
                location: slot.location,
                courseExternalId: slot.courseExternalId,
                courseTitle: slot.courseTitle,
                source: 'agent_timetable',
              },
            });
          } catch {
            await this.courseRep.createStudyPlanEvent({
              userId: courseRepUserId,
              type: 'outside_activity',
              title: slot.title,
              startsAt: slot.startsAt ?? undefined,
              endsAt: slot.endsAt ?? undefined,
              metadata: {
                dayOfWeek: slot.dayOfWeek,
                location: slot.location,
                courseExternalId: slot.courseExternalId,
                courseTitle: slot.courseTitle,
                source: 'agent_timetable',
                intendedType: 'class_session',
              },
            });
          }
        },
      });
    }

    for (const event of calendarEvents) {
      jobs.push({
        kind: 'calendar',
        run: async () => {
          await this.courseRep.createStudyPlanEvent({
            userId: courseRepUserId,
            type: this.mapEventType(event.eventType),
            title: event.title,
            startsAt: event.startsAt ?? undefined,
            endsAt: event.endsAt ?? undefined,
            dueAt: event.startsAt ?? undefined,
          });
        },
      });
    }

    const counts = await this.runJobsWithBudget(jobs, EVENT_CONCURRENCY, EVENT_BUDGET_MS);
    const syncedAssignments = counts.assignment;
    const syncedTimetable = counts.timetable;
    const syncedEvents = counts.calendar;

    if (syncedAssignments > 0) {
      await prisma.discoveredAssignment.updateMany({
        where: { onboardingSessionId: sessionId, selected: true },
        data: { syncedAt: new Date() },
      });
    }
    if (syncedTimetable > 0) {
      await prisma.discoveredTimetableSlot.updateMany({
        where: { onboardingSessionId: sessionId, selected: true },
        data: { syncedAt: new Date() },
      });
    }
    if (syncedEvents > 0) {
      await prisma.discoveredCalendarEvent.updateMany({
        where: { onboardingSessionId: sessionId, selected: true },
        data: { syncedAt: new Date() },
      });
    }

    if (session.universityId) {
      const account = await prisma.connectedAccount.findFirst({
        where: { onboardingSessionId: sessionId },
        orderBy: { createdAt: 'desc' },
      });
      if (account) {
        await this.courseRep
          .updateUniversityPortal({
            universityId: session.universityId,
            studentPortalUrl: account.lmsBaseUrl,
            lmsType: account.lmsType,
          })
          .catch(() => undefined);
      }
    }

    await prisma.connectedAccount.updateMany({
      where: { onboardingSessionId: sessionId },
      data: { lastSyncAt: new Date() },
    });

    await this.courseRep.recomputeStudyPlan(courseRepUserId).catch(() => undefined);

    await writeAuditLog({
      actorId: courseRepUserId,
      action: 'onboarding_synced_to_course_rep',
      resourceType: 'onboarding_session',
      resourceId: sessionId,
      metadata: {
        importedCourses,
        syncedAssignments,
        syncedTimetable,
        syncedEvents,
        eventJobsTotal: jobs.length,
        eventJobsSkipped: Math.max(0, jobs.length - (syncedAssignments + syncedTimetable + syncedEvents)),
      },
    });

    return {
      importedCourses,
      syncedAssignments,
      syncedTimetable,
      syncedEvents,
      // Back-compat for existing web clients.
      syncedEventsTotal: syncedAssignments + syncedTimetable + syncedEvents,
    };
  }

  private async runJobsWithBudget(
    jobs: Array<{ kind: 'assignment' | 'timetable' | 'calendar'; run: () => Promise<void> }>,
    concurrency: number,
    budgetMs: number,
  ): Promise<Record<'assignment' | 'timetable' | 'calendar', number>> {
    const counts = { assignment: 0, timetable: 0, calendar: 0 };
    if (jobs.length === 0) return counts;

    const started = Date.now();
    let next = 0;
    let stoppedEarly = false;

    const worker = async () => {
      while (true) {
        if (Date.now() - started > budgetMs) {
          stoppedEarly = true;
          return;
        }
        const i = next++;
        if (i >= jobs.length) return;
        const job = jobs[i];
        try {
          await job.run();
          counts[job.kind] += 1;
        } catch (err) {
          this.logger.warn(
            `sync event failed (${job.kind}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    };

    const n = Math.min(concurrency, jobs.length);
    await Promise.all(Array.from({ length: n }, () => worker()));
    if (stoppedEarly) {
      this.logger.warn(
        `sync event budget ${budgetMs}ms exhausted; completed ${counts.assignment + counts.timetable + counts.calendar}/${jobs.length}`,
      );
    }
    return counts;
  }

  private mapAssignmentType(eventType: string | null): string {
    switch ((eventType ?? '').toLowerCase()) {
      case 'exam':
      case 'test':
        return 'test';
      case 'quiz':
        return 'test';
      case 'assignment':
      default:
        return 'assignment';
    }
  }

  private mapEventType(eventType: string | null): string {
    switch ((eventType ?? '').toLowerCase()) {
      case 'exam':
      case 'test':
        return 'test';
      case 'assignment':
        return 'assignment';
      case 'presentation':
        return 'presentation';
      case 'lab':
      case 'practical':
        return 'lab_practical';
      case 'class':
      case 'lecture':
      case 'class_session':
        return 'class_session';
      default:
        return 'outside_activity';
    }
  }
}
