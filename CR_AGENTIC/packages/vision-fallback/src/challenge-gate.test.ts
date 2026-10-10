import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  publishAndWaitForChallenge,
  readPendingChallenge,
  submitChallengeAnswer,
  visionChallengeKey,
  type ChallengeRedis,
} from './challenge';
import { pageChallenge } from './safety';
import type { VisionChallenge } from './types';

describe('challenge answer gate', () => {
  it('classifies captcha, otp, and security questions from page text', () => {
    assert.equal(pageChallenge("Type the characters in the image\nI'm not a robot")?.kind, 'captcha');
    assert.equal(pageChallenge('A verification code was sent to your phone')?.kind, 'otp');
    assert.equal(pageChallenge("Security question\nWhat is your mother's maiden name?")?.kind, 'security_question');
    assert.equal(pageChallenge('Course registration is closed')?.kind, undefined);
  });

  it('stores the answer for the executor and drops it from the public challenge', async () => {
    const redis = memoryRedis();
    const challenge = sample(1_000);
    const waiting = publishAndWaitForChallenge(redis, 'session-1', challenge, {
      now: () => 1_000,
      pollMs: 10,
      sleep: async () => {
        await submitChallengeAnswer(redis, 'session-1', 'student-secret', { now: 1_000 });
      },
    });
    const result = await waiting;
    assert.deepEqual(result, { status: 'answer', answer: 'student-secret' });
    const pending = await readPendingChallenge(redis, 'session-1', 1_000);
    assert.equal(pending, null);
    const dumped = JSON.stringify(redis.dump());
    assert.equal(dumped.includes('student-secret'), false);
  });

  it('accepts several challenges and expires a late answer', async () => {
    const redis = memoryRedis();
    const first = sample(0);
    const second = { ...sample(0), id: 'challenge-2', kind: 'otp' as const, prompt: 'Enter the verification code.' };
    let clock = 0;
    const sleep = async () => {
      if (clock === 0) {
        const accepted = await submitChallengeAnswer(redis, 's', 'one', { now: 0 });
        assert.equal(accepted.ok, true);
        if (accepted.ok) assert.equal(accepted.challengeId, first.id);
      }
      clock += 50;
    };
    const firstResult = await publishAndWaitForChallenge(redis, 's', first, { now: () => clock, sleep, pollMs: 50 });
    assert.deepEqual(firstResult, { status: 'answer', answer: 'one' });

    const expired = await submitChallengeAnswer(redis, 's', 'late', {
      now: Date.parse(second.expiresAt),
      sessionExpiresAt: Date.parse(second.expiresAt) + 10_000,
    });
    assert.deepEqual(expired, { ok: false, reason: 'NONE' });

    await redis.set(visionChallengeKey('s'), JSON.stringify(second), 'EX', 60);
    const stillThere = await submitChallengeAnswer(redis, 's', 'late', {
      now: Date.parse(second.expiresAt),
      sessionExpiresAt: Date.parse(second.expiresAt) + 10_000,
    });
    assert.deepEqual(stillThere, { ok: false, reason: 'EXPIRED' });
    assert.equal(JSON.stringify(redis.dump()).includes('late'), false);

    const sessionGone = await publishAndWaitForChallenge(redis, 's', second, {
      now: () => 0,
      sleep: async () => undefined,
      pollMs: 1,
      isSessionOpen: async () => false,
    });
    assert.deepEqual(sessionGone, { status: 'session_expired' });
    const afterExpiry = await submitChallengeAnswer(redis, 's', 'too-late', {
      now: 0,
      sessionExpiresAt: 0,
    });
    assert.deepEqual(afterExpiry, { ok: false, reason: 'SESSION_EXPIRED' });
  });

  it('returns CHALLENGE_TIMEOUT once the prompt window has passed', async () => {
    const redis = memoryRedis();
    const challenge = sample(0);
    let clock = 0;
    const result = await publishAndWaitForChallenge(redis, 's', challenge, {
      now: () => clock,
      pollMs: 100,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    assert.deepEqual(result, { status: 'timeout' });
    const pending = await readPendingChallenge(redis, 's', clock);
    assert.equal(pending, null);
  });
});

function sample(now: number): VisionChallenge {
  return {
    id: 'challenge-1',
    kind: 'captcha',
    prompt: 'Enter the characters shown in the captcha image.',
    imagePngBase64: 'aGVsbG8=',
    expiresAt: new Date(now + 1_000).toISOString(),
  };
}

function memoryRedis(): ChallengeRedis & { dump: () => Record<string, string> } {
  const rows = new Map<string, { value: string; expiresAt: number }>();
  return {
    async get(key) {
      const row = rows.get(key);
      if (!row) return null;
      if (row.expiresAt <= Date.now()) {
        rows.delete(key);
        return null;
      }
      return row.value;
    },
    async set(key, value, _mode, ttlSeconds) {
      rows.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
      return 'OK';
    },
    async del(...keys) {
      for (const key of keys) rows.delete(key);
      return keys.length;
    },
    dump: () => Object.fromEntries([...rows].map(([key, row]) => [key, row.value])),
  };
}
