import { BadGatewayException, Injectable } from '@nestjs/common';
import { prisma } from '@cr-agentic/database';
import { writeAuditLog } from '@cr-agentic/observability';
import { CourseRepClient } from '../../integrations/course-rep/course-rep.client';
import { OnboardingService } from './onboarding.service';

@Injectable()
export class SyncService {
  constructor(
    private readonly courseRep: CourseRepClient,
    private readonly onboarding: OnboardingService,
  ) {}

  /**
   * Pushes the user's selected discovered courses, assignments, timetable slots,
   * and calendar events to the main Course Rep API.
   */
  async syncToCourseRep(userId: string, sessionId: string) {
    const session = await this.onboarding.requireSession(userId, sessionId);

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
    const courseIdByExternal = new Map<string, string>();
    const courseIdByTitle = new Map<string, string>();

    if (courses.length > 0) {
      let result: { imported: number };
      try {
        result = await this.courseRep.importCourses({
          userId,
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

      // Best-effort: re-fetch offerings aren't available; map by title for event linking.
      for (const c of courses) {
        if (c.externalId) courseIdByExternal.set(c.externalId, c.id);
        courseIdByTitle.set(c.title.toLowerCase(), c.id);
      }

      await prisma.discoveredCourse.updateMany({
        where: { onboardingSessionId: sessionId, selected: true },
        data: { syncedAt: new Date() },
      });
    }

    let syncedAssignments = 0;
    for (const assignment of assignments) {
      await this.courseRep.createStudyPlanEvent({
        userId,
        type: this.mapAssignmentType(assignment.eventType),
        title: assignment.title,
        dueAt: assignment.dueAt ?? undefined,
        startsAt: assignment.dueAt ?? undefined,
      });
      syncedAssignments += 1;
    }
    if (syncedAssignments > 0) {
      await prisma.discoveredAssignment.updateMany({
        where: { onboardingSessionId: sessionId, selected: true },
        data: { syncedAt: new Date() },
      });
    }

    let syncedTimetable = 0;
    for (const slot of timetableSlots) {
      // Prefer class_session; fall back to outside_activity if the main DB
      // enum has not been migrated yet.
      try {
        await this.courseRep.createStudyPlanEvent({
          userId,
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
          userId,
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
      syncedTimetable += 1;
    }
    if (syncedTimetable > 0) {
      await prisma.discoveredTimetableSlot.updateMany({
        where: { onboardingSessionId: sessionId, selected: true },
        data: { syncedAt: new Date() },
      });
    }

    let syncedEvents = 0;
    for (const event of calendarEvents) {
      await this.courseRep.createStudyPlanEvent({
        userId,
        type: this.mapEventType(event.eventType),
        title: event.title,
        startsAt: event.startsAt ?? undefined,
        endsAt: event.endsAt ?? undefined,
        dueAt: event.startsAt ?? undefined,
      });
      syncedEvents += 1;
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

    await this.courseRep.recomputeStudyPlan(userId).catch(() => undefined);

    await writeAuditLog({
      actorId: userId,
      action: 'onboarding_synced_to_course_rep',
      resourceType: 'onboarding_session',
      resourceId: sessionId,
      metadata: {
        importedCourses,
        syncedAssignments,
        syncedTimetable,
        syncedEvents,
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
