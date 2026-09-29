/**
 * Guest / claim identity helpers for school-first onboarding.
 *
 * Guest tokens are persisted as SHA-256 hashes on onboarding_sessions.metadata
 * (Postgres). Redis is not involved in guest verification — credentials and
 * job payloads use Redis; an agent recreate that wipes Redis must not
 * invalidate an in-flight onboarding session.
 */

export type GuestTokenFailureReason = 'missing' | 'expired' | 'mismatch';

export type OnboardingSessionMetadata = {
  isGuest?: boolean;
  guestTokenHash?: string;
  guestTokenExpiresAt?: string;
  previousUserId?: string;
  claimedAt?: string;
  [key: string]: unknown;
};

export type ActorResolution =
  | { ok: true; userId: string; via: 'jwt' | 'guest' | 'previous-jwt' }
  | { ok: false; reason: 'missing' | 'expired' | 'mismatch' };

export function asSessionMetadata(value: unknown): OnboardingSessionMetadata {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
}

export function isUnclaimedGuestSession(session: {
  userId: string;
  metadata?: unknown;
}): boolean {
  const meta = asSessionMetadata(session.metadata);
  if (meta.claimedAt || meta.previousUserId) {
    return false;
  }
  return meta.isGuest === true;
}

export function buildClaimedSessionMetadata(
  existing: unknown,
  previousUserId: string,
  claimedAt: Date = new Date(),
): OnboardingSessionMetadata {
  const meta = asSessionMetadata(existing);
  return {
    ...meta,
    isGuest: false,
    previousUserId,
    claimedAt: claimedAt.toISOString(),
    // Keep guestTokenHash / guestTokenExpiresAt so in-flight clients can
    // finish apply/sync with the original guest header after claim.
  };
}

/**
 * Authoritative Course Rep userId for import/sync. Throws if the session is
 * still attached to a provisional guest UUID that does not exist on main API.
 */
export function courseRepUserIdForSync(session: {
  userId: string;
  metadata?: unknown;
}): string {
  if (isUnclaimedGuestSession(session)) {
    throw new Error(
      'Onboarding session is still attached to a provisional guest userId; claim-identity must succeed before sync',
    );
  }
  return session.userId;
}

export function resolveOnboardingActorFromSession(params: {
  sessionUserId: string;
  metadata: unknown;
  jwtUserId?: string;
  guestToken?: string;
  inspectGuestToken?: (
    token: string,
    storedHash: string | null,
    expiresAt: Date | null,
  ) => { ok: true } | { ok: false; reason: GuestTokenFailureReason };
}): ActorResolution {
  const { sessionUserId, jwtUserId, guestToken } = params;
  const meta = asSessionMetadata(params.metadata);

  if (jwtUserId && jwtUserId === sessionUserId) {
    return { ok: true, userId: jwtUserId, via: 'jwt' };
  }

  if (jwtUserId && meta.previousUserId && jwtUserId === meta.previousUserId) {
    // Client still presenting the pre-claim identity; session already remapped.
    return { ok: true, userId: sessionUserId, via: 'previous-jwt' };
  }

  if (guestToken) {
    if (!params.inspectGuestToken) {
      return { ok: false, reason: 'missing' };
    }
    const inspected = params.inspectGuestToken(
      guestToken,
      meta.guestTokenHash ?? null,
      meta.guestTokenExpiresAt ? new Date(meta.guestTokenExpiresAt) : null,
    );
    if (inspected.ok) {
      return { ok: true, userId: sessionUserId, via: 'guest' };
    }
    if (!jwtUserId) {
      return { ok: false, reason: inspected.reason };
    }
  }

  if (jwtUserId) {
    return { ok: false, reason: 'mismatch' };
  }

  return { ok: false, reason: 'missing' };
}

export function actorAuthErrorMessage(reason: 'missing' | 'expired' | 'mismatch'): string {
  switch (reason) {
    case 'expired':
      return 'Onboarding guest token expired. Re-run school connect or retry claim-identity with a valid token.';
    case 'mismatch':
      return 'Authentication does not match this onboarding session. Provide the Course Rep JWT from claim-identity or a valid X-Onboarding-Guest-Token.';
    case 'missing':
    default:
      return 'Authentication required: provide a Course Rep JWT or a valid X-Onboarding-Guest-Token for this onboarding session.';
  }
}
