import {
  readPendingChallenge,
  visionChallengeKey,
  type ChallengeRedis,
  type VisionChallenge,
} from '@cr-agentic/vision-fallback';

export interface ChallengeView {
  visionStatus: 'AWAITING_USER_INPUT' | 'SESSION_EXPIRED' | null;
  challenge: VisionChallenge | null;
}

/**
 * Public challenge shown while the vision browser is paused.
 * The stored answer is a different Redis key and is not read here.
 */
export async function loadChallengeView(
  redis: ChallengeRedis,
  sessionId: string,
  sessionExpiresAt: Date,
  now = Date.now(),
): Promise<ChallengeView> {
  if (sessionExpiresAt.getTime() <= now) {
    const pending = await readPendingChallenge(redis, sessionId, now);
    if (pending) await redis.del(visionChallengeKey(sessionId));
    return { visionStatus: pending ? 'SESSION_EXPIRED' : null, challenge: null };
  }
  const challenge = await readPendingChallenge(redis, sessionId, now);
  if (!challenge) return { visionStatus: null, challenge: null };
  return { visionStatus: 'AWAITING_USER_INPUT', challenge };
}
