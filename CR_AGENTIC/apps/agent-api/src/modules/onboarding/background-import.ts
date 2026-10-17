/**
 * Background portal import: decide when a student who left the import screen
 * should be told about it, and what the push says. Pure functions only, so the
 * rules are unit-tested without Nest, Prisma or FCM.
 */

export type BackgroundImportStatus = 'ready' | 'needs_action' | 'failed';

/** Stored on `OnboardingSession.metadata.backgroundImport`. */
export interface BackgroundImportState {
  notifyOnFinish: boolean;
  requestedAt: string;
  /** status -> ISO time the push was queued. One push per status per session. */
  notified?: Partial<Record<BackgroundImportStatus, string>>;
}

export interface BackgroundImportSnapshot {
  stage: string;
  discoveryStatus: string | null;
  courseCount: number;
  /** Reason recorded on the latest REAUTH_REQUIRED / FAILED transition. */
  reason?: string | null;
  requestedAt: Date | null;
  expiresAt: Date;
  now: Date;
}

export interface BackgroundImportOutcome {
  status: BackgroundImportStatus;
  reason?: string;
}

/** A scan still running this long after the student left is treated as failed. */
export const BACKGROUND_IMPORT_STALL_MS = 45 * 60 * 1000;

const QUIET_STAGES = new Set(['ONBOARDING_COMPLETE', 'CANCELLED']);

export function readBackgroundImportState(metadata: unknown): BackgroundImportState | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = (metadata as Record<string, unknown>).backgroundImport;
  if (!raw || typeof raw !== 'object') return null;
  const state = raw as Partial<BackgroundImportState>;
  if (state.notifyOnFinish !== true) return null;
  return {
    notifyOnFinish: true,
    requestedAt: typeof state.requestedAt === 'string' ? state.requestedAt : new Date(0).toISOString(),
    notified: state.notified && typeof state.notified === 'object' ? { ...state.notified } : {},
  };
}

/**
 * Guest sessions belong to a provisional id until claim-identity remaps them to
 * a real Course Rep user. The main API has no devices for a provisional id.
 */
export function sessionCanReceivePush(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return true;
  const m = metadata as Record<string, unknown>;
  if (m.isGuest !== true) return true;
  return typeof m.previousUserId === 'string' || typeof m.claimedAt === 'string';
}

/** What, if anything, the student should be told right now. */
export function decideBackgroundOutcome(s: BackgroundImportSnapshot): BackgroundImportOutcome | null {
  if (QUIET_STAGES.has(s.stage)) return null;
  if (s.expiresAt.getTime() <= s.now.getTime()) return null;

  if (s.stage === 'REAUTH_REQUIRED') {
    return { status: 'needs_action', ...(s.reason ? { reason: s.reason } : {}) };
  }
  if (s.stage === 'FAILED' || s.discoveryStatus === 'FAILED') {
    return { status: 'failed', ...(s.reason ? { reason: s.reason } : {}) };
  }
  if (s.stage === 'DEEP_DISCOVERY' && s.discoveryStatus === 'COMPLETE') {
    return { status: 'ready' };
  }
  const scanning =
    (s.stage === 'DEEP_DISCOVERY' || s.stage === 'SESSION_CAPTURED') &&
    s.discoveryStatus !== 'COMPLETE';
  if (
    scanning &&
    s.requestedAt &&
    s.now.getTime() - s.requestedAt.getTime() >= BACKGROUND_IMPORT_STALL_MS
  ) {
    return { status: 'failed', reason: 'stalled' };
  }
  return null;
}

export interface BackgroundImportPush {
  title: string;
  message: string;
  dedupeKey: string;
  /** FCM data values must all be strings. */
  data: Record<string, string>;
}

function portalPhrase(universityName?: string | null): string {
  const name = universityName?.trim();
  return name ? `your ${name} portal` : 'your school portal';
}

function schoolSubject(universityName?: string | null): string {
  const name = universityName?.trim();
  return name || 'Your school portal';
}

export function buildBackgroundImportPush(
  outcome: BackgroundImportOutcome,
  ctx: { sessionId: string; universityName?: string | null; courseCount: number },
): BackgroundImportPush {
  let title: string;
  let message: string;
  const n = Math.max(0, Math.floor(ctx.courseCount));

  switch (outcome.status) {
    case 'ready':
      if (n > 0) {
        title = 'Your courses are ready';
        message = `We found ${n} ${n === 1 ? 'course' : 'courses'} on ${portalPhrase(ctx.universityName)}. Tap to review and add them.`;
      } else {
        title = 'Your portal scan is done';
        message = `We didn't find any courses on ${portalPhrase(ctx.universityName)}. Tap to scan again or try a different portal.`;
      }
      break;
    case 'needs_action':
      if (outcome.reason === 'invalid_credentials') {
        title = "Couldn't sign in to your portal";
        message = "Your password didn't work. Tap to check it and try again.";
      } else if (outcome.reason === 'captcha_required') {
        title = 'Your portal needs you';
        message = `${schoolSubject(ctx.universityName)} asked for a captcha. Tap to sign in once and we'll finish importing your courses.`;
      } else {
        title = 'Your portal needs you';
        message = `${schoolSubject(ctx.universityName)} needs you to sign in yourself. Tap to sign in once and we'll finish importing your courses.`;
      }
      break;
    case 'failed':
    default:
      title = "We couldn't finish your import";
      message = 'Tap to try again or pick a different portal.';
      break;
  }

  return {
    title,
    message,
    dedupeKey: `onboarding:${ctx.sessionId}:${outcome.status}`,
    data: {
      type: 'portal_import',
      route: '/school-connect',
      sessionId: ctx.sessionId,
      status: outcome.status,
      courseCount: String(n),
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    },
  };
}
