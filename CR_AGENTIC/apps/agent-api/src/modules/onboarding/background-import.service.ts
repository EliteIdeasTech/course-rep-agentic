import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, prisma } from '@cr-agentic/database';
import type { OnboardingStage } from '@cr-agentic/database';
import { createLogger } from '@cr-agentic/observability';
import { AgentNotificationService } from '../notifications/notifications.service';
import { OnboardingService } from './onboarding.service';
import {
  buildBackgroundImportPush,
  decideBackgroundOutcome,
  readBackgroundImportState,
  sessionCanReceivePush,
  type BackgroundImportOutcome,
  type BackgroundImportState,
  type BackgroundImportStatus,
} from './background-import';

type SessionRow = Awaited<ReturnType<typeof prisma.onboardingSession.findFirst>> & object;

/**
 * Lets a student leave the import screen. The scan already runs in the
 * discovery worker; this records that they want to be told, and a sweep sends
 * one push per outcome (ready / needs_action / failed) through the existing
 * notifications queue -> main API /internal/notifications -> FCM.
 */
@Injectable()
export class BackgroundImportService {
  private readonly logger = createLogger('background-import');
  private sweeping = false;

  constructor(
    private readonly onboarding: OnboardingService,
    private readonly notifications: AgentNotificationService,
  ) {}

  /** POST /onboarding/:sessionId/notify-on-finish */
  async enable(userId: string, sessionId: string) {
    const session = await this.onboarding.requireSession(userId, sessionId);
    const pushAvailable = sessionCanReceivePush(session.metadata);
    const existing = readBackgroundImportState(session.metadata);
    const state: BackgroundImportState = existing ?? {
      notifyOnFinish: true,
      requestedAt: new Date().toISOString(),
      notified: {},
    };
    if (!existing && pushAvailable) {
      await this.writeState(session, state);
    }
    const snapshot = await this.snapshot(session, state);
    return {
      notifyOnFinish: pushAvailable,
      pushAvailable,
      outcome: decideBackgroundOutcome(snapshot),
      discoveryStatus: snapshot.discoveryStatus,
      discoveredCourseCount: snapshot.courseCount,
    };
  }

  /** Read-only view used by GET /onboarding/:sessionId. */
  async describe(session: SessionRow) {
    const state = readBackgroundImportState(session.metadata);
    const snapshot = await this.snapshot(session, state);
    return {
      notifyOnFinish: state?.notifyOnFinish === true,
      outcome: decideBackgroundOutcome(snapshot),
      discoveryStatus: snapshot.discoveryStatus,
      discoveredCourseCount: snapshot.courseCount,
      importReady: snapshot.stage === 'DEEP_DISCOVERY' && snapshot.discoveryStatus === 'COMPLETE',
    };
  }

  @Cron('*/15 * * * * *')
  async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const sessions = await prisma.onboardingSession.findMany({
        where: {
          metadata: { path: ['backgroundImport', 'notifyOnFinish'], equals: true },
          expiresAt: { gt: new Date() },
          stage: { notIn: ['ONBOARDING_COMPLETE', 'CANCELLED'] as OnboardingStage[] },
        },
        orderBy: { updatedAt: 'asc' },
        take: 50,
      });
      for (const session of sessions) {
        try {
          await this.maybeNotify(session);
        } catch (err) {
          this.logger.error({ err, onboardingSessionId: session.id }, 'Background import notify failed');
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  /** Exposed for tests and the sweep. Returns the status that was queued, if any. */
  async maybeNotify(session: SessionRow): Promise<BackgroundImportStatus | null> {
    const state = readBackgroundImportState(session.metadata);
    if (!state || !sessionCanReceivePush(session.metadata)) return null;
    const snapshot = await this.snapshot(session, state);
    const outcome = decideBackgroundOutcome(snapshot);
    if (!outcome || state.notified?.[outcome.status]) return null;

    // Claim first so an overlapping sweep or restart can't send it twice. The
    // main API also dedupes on the same key.
    const claimed: BackgroundImportState = {
      ...state,
      notified: { ...state.notified, [outcome.status]: new Date().toISOString() },
    };
    await this.writeState(session, claimed);

    try {
      await this.send(session, outcome, snapshot.courseCount);
    } catch (err) {
      await this.writeState(session, state).catch(() => undefined);
      throw err;
    }
    this.logger.info(
      { onboardingSessionId: session.id, status: outcome.status, courseCount: snapshot.courseCount },
      'Background import push queued',
    );
    return outcome.status;
  }

  private async send(session: SessionRow, outcome: BackgroundImportOutcome, courseCount: number) {
    const push = buildBackgroundImportPush(outcome, {
      sessionId: session.id,
      universityName: session.universityName,
      courseCount,
    });
    await this.notifications.sendNotification({
      userId: session.userId,
      title: push.title,
      message: push.message,
      dedupeKey: push.dedupeKey,
      metadata: push.data,
    });
  }

  private async snapshot(session: SessionRow, state: BackgroundImportState | null) {
    const [account, courseCount, event] = await Promise.all([
      prisma.connectedAccount.findFirst({
        where: { onboardingSessionId: session.id },
        orderBy: { createdAt: 'desc' },
        select: { discoveryStatus: true },
      }),
      prisma.discoveredCourse.count({ where: { onboardingSessionId: session.id } }),
      session.stage === 'REAUTH_REQUIRED' || session.stage === 'FAILED'
        ? prisma.onboardingAuditEvent.findFirst({
            where: { onboardingSessionId: session.id, toStage: session.stage },
            orderBy: { createdAt: 'desc' },
            select: { detail: true },
          })
        : Promise.resolve(null),
    ]);
    const reason = (event?.detail as { reason?: unknown } | null)?.reason;
    return {
      stage: session.stage as string,
      discoveryStatus: (account?.discoveryStatus as string | undefined) ?? null,
      courseCount,
      reason: typeof reason === 'string' ? reason : null,
      requestedAt: state ? new Date(state.requestedAt) : null,
      expiresAt: session.expiresAt,
      now: new Date(),
    };
  }

  private async writeState(session: SessionRow, state: BackgroundImportState) {
    // Re-read so we never clobber metadata written since the session was loaded
    // (claim-identity, guest token, login bridge).
    const fresh = await prisma.onboardingSession.findUnique({
      where: { id: session.id },
      select: { metadata: true },
    });
    const metadata = {
      ...((fresh?.metadata as Record<string, unknown> | null) ?? {}),
      backgroundImport: state,
    };
    await prisma.onboardingSession.update({
      where: { id: session.id },
      data: { metadata: metadata as unknown as Prisma.InputJsonValue },
    });
    session.metadata = metadata as unknown as Prisma.JsonValue;
  }
}
