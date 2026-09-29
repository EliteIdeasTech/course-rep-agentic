import { describe, expect, it } from 'vitest';
import {
  createGuestToken,
  hashToken,
  inspectGuestToken,
} from '../src/modules/onboarding/bridge-token';
import {
  actorAuthErrorMessage,
  asSessionMetadata,
  buildClaimedSessionMetadata,
  courseRepUserIdForSync,
  isUnclaimedGuestSession,
  resolveOnboardingActorFromSession,
} from '../src/modules/onboarding/onboarding-identity';
import { parseExpiresToSeconds } from '../src/modules/auth/jwt-options';

const SESSION_ID = '3f7fd4e1-dd1e-49f3-b59b-b0d1cc494bf8';
const PROVISIONAL = '085d879d-5168-4729-9e37-8c04956ed99c';
const COURSE_REP_USER = 'ca48dfbd-541e-4b7d-aed3-07d772844270';

describe('guest token persistence', () => {
  it('accepts a token after SESSION_ENCRYPTION_KEY rotation (Postgres hash, not Redis/HMAC)', () => {
    const issued = createGuestToken(SESSION_ID, 'original-secret');
    const inspected = inspectGuestToken(
      issued.token,
      SESSION_ID,
      'rotated-after-agent-recreate',
      issued.tokenHash,
      issued.expiresAt,
    );
    expect(inspected).toEqual({ ok: true });
    expect(hashToken(issued.token)).toBe(issued.tokenHash);
  });

  it('rejects an expired guest token with a clear reason instead of half-auth', () => {
    const issued = createGuestToken(SESSION_ID, 'secret');
    const expiredAt = new Date(Date.now() - 1000);
    expect(
      inspectGuestToken(issued.token, SESSION_ID, 'secret', issued.tokenHash, expiredAt),
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a missing stored hash (token never persisted on the session)', () => {
    const issued = createGuestToken(SESSION_ID, 'secret');
    expect(
      inspectGuestToken(issued.token, SESSION_ID, 'secret', null, issued.expiresAt),
    ).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('claim remaps onboarding userId', () => {
  it('preserves guestTokenHash and records previousUserId when claiming', () => {
    const issued = createGuestToken(SESSION_ID, 'secret');
    const existing = {
      isGuest: true,
      guestTokenHash: issued.tokenHash,
      guestTokenExpiresAt: issued.expiresAt.toISOString(),
    };
    const claimed = buildClaimedSessionMetadata(existing, PROVISIONAL);
    expect(claimed.isGuest).toBe(false);
    expect(claimed.previousUserId).toBe(PROVISIONAL);
    expect(claimed.claimedAt).toBeTruthy();
    expect(claimed.guestTokenHash).toBe(issued.tokenHash);
    expect(claimed.guestTokenExpiresAt).toBe(existing.guestTokenExpiresAt);
  });

  it('treats a session as unclaimed only before remap metadata is written', () => {
    expect(
      isUnclaimedGuestSession({
        userId: PROVISIONAL,
        metadata: { isGuest: true, guestTokenHash: 'abc' },
      }),
    ).toBe(true);
    expect(
      isUnclaimedGuestSession({
        userId: COURSE_REP_USER,
        metadata: {
          isGuest: false,
          previousUserId: PROVISIONAL,
          claimedAt: new Date().toISOString(),
        },
      }),
    ).toBe(false);
  });
});

describe('sync uses remapped Course Rep userId', () => {
  it('imports with the remapped userId after claim', () => {
    const userId = courseRepUserIdForSync({
      userId: COURSE_REP_USER,
      metadata: {
        isGuest: false,
        previousUserId: PROVISIONAL,
        claimedAt: '2026-09-21T00:00:00.000Z',
      },
    });
    expect(userId).toBe(COURSE_REP_USER);
    expect(userId).not.toBe(PROVISIONAL);
  });

  it('refuses to sync while the session is still a provisional guest', () => {
    expect(() =>
      courseRepUserIdForSync({
        userId: PROVISIONAL,
        metadata: { isGuest: true },
      }),
    ).toThrow(/provisional guest userId/i);
  });
});

describe('resolveActor after claim', () => {
  const inspectOk = () => ({ ok: true as const });
  const inspectExpired = () => ({ ok: false as const, reason: 'expired' as const });
  const inspectMissing = () => ({ ok: false as const, reason: 'missing' as const });

  it('returns the remapped userId for a valid guest token after claim', () => {
    const resolved = resolveOnboardingActorFromSession({
      sessionUserId: COURSE_REP_USER,
      metadata: {
        isGuest: false,
        previousUserId: PROVISIONAL,
        claimedAt: '2026-09-21T00:00:00.000Z',
        guestTokenHash: 'hash',
        guestTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      guestToken: 'guest-token',
      inspectGuestToken: inspectOk,
    });
    expect(resolved).toEqual({ ok: true, userId: COURSE_REP_USER, via: 'guest' });
  });

  it('accepts the claim-identity JWT for the remapped user', () => {
    const resolved = resolveOnboardingActorFromSession({
      sessionUserId: COURSE_REP_USER,
      metadata: {
        isGuest: false,
        previousUserId: PROVISIONAL,
        claimedAt: '2026-09-21T00:00:00.000Z',
      },
      jwtUserId: COURSE_REP_USER,
    });
    expect(resolved).toEqual({ ok: true, userId: COURSE_REP_USER, via: 'jwt' });
  });

  it('returns a clear error when the guest token is expired and no JWT is present', () => {
    const resolved = resolveOnboardingActorFromSession({
      sessionUserId: PROVISIONAL,
      metadata: {
        isGuest: true,
        guestTokenHash: 'hash',
        guestTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      },
      guestToken: 'stale-guest',
      inspectGuestToken: inspectExpired,
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.reason).toBe('expired');
      expect(actorAuthErrorMessage(resolved.reason)).toMatch(/expired/i);
    }
  });

  it('returns a clear error when auth is missing instead of proceeding half-authenticated', () => {
    const resolved = resolveOnboardingActorFromSession({
      sessionUserId: PROVISIONAL,
      metadata: { isGuest: true },
      inspectGuestToken: inspectMissing,
    });
    expect(resolved).toEqual({ ok: false, reason: 'missing' });
    if (!resolved.ok) {
      expect(actorAuthErrorMessage(resolved.reason)).toMatch(/JWT or a valid X-Onboarding-Guest-Token/i);
    }
  });
});

describe('session metadata merge', () => {
  it('does not drop fields when metadata is a Prisma JSON object', () => {
    const merged = asSessionMetadata({
      isGuest: true,
      guestTokenHash: 'abc',
      extra: 1,
    });
    expect(merged.guestTokenHash).toBe('abc');
    expect(merged.extra).toBe(1);
  });
});

describe('jwt expiry parsing', () => {
  it('parses Course Rep style JWT_EXPIRES_IN values', () => {
    expect(parseExpiresToSeconds('90d')).toBe(90 * 86400);
    expect(parseExpiresToSeconds('1h')).toBe(3600);
    expect(parseExpiresToSeconds(undefined)).toBe(3600);
  });
});
