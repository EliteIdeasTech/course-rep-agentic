import { randomUUID } from 'crypto';
import {
  DEFAULT_CHALLENGE_TIMEOUT_MS,
  type ChallengeWaitResult,
  type VisionChallenge,
  type VisionChallengeKind,
} from './types';

const STUDENT_KINDS = new Set<VisionChallengeKind>(['otp', 'captcha', 'security_question']);

export function visionChallengeKey(sessionId: string): string {
  return `cr:agent:vision-challenge:${sessionId}`;
}

export function visionChallengeAnswerKey(sessionId: string, challengeId: string): string {
  return `cr:agent:vision-challenge-answer:${sessionId}:${challengeId}`;
}

export function challengeTimeoutFromEnv(env: { VISION_CHALLENGE_TIMEOUT_MS?: string }): number {
  const n = Number(env.VISION_CHALLENGE_TIMEOUT_MS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHALLENGE_TIMEOUT_MS;
  return Math.floor(n);
}

export function challengeFromModelText(text: string): { kind: VisionChallengeKind; prompt: string } | null {
  const match = text.match(/USER_INPUT\s*(\{[\s\S]*?\})/);
  if (match) {
    try {
      const body = JSON.parse(match[1]) as { kind?: unknown; prompt?: unknown };
      const kind = studentKind(body.kind);
      if (!kind) return null;
      return {
        kind,
        prompt: typeof body.prompt === 'string' && body.prompt.trim()
          ? body.prompt.trim().slice(0, 280)
          : fallbackPrompt(kind),
      };
    } catch {
      return null;
    }
  }
  if (/CAPTCHA_REQUIRED/i.test(text)) return { kind: 'captcha', prompt: fallbackPrompt('captcha') };
  if (/OTP_REQUIRED/i.test(text)) return { kind: 'otp', prompt: fallbackPrompt('otp') };
  return null;
}

export function createChallenge(input: {
  kind: VisionChallengeKind;
  prompt: string;
  imagePngBase64?: string;
  now: number;
  timeoutMs: number;
}): VisionChallenge {
  const image = input.imagePngBase64 && input.imagePngBase64.length <= 400_000
    ? input.imagePngBase64
    : undefined;
  return {
    id: randomUUID(),
    kind: input.kind,
    prompt: input.prompt.slice(0, 280),
    ...(image ? { imagePngBase64: image } : {}),
    expiresAt: new Date(input.now + input.timeoutMs).toISOString(),
  };
}

export interface ChallengeRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiryMode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

export interface ChallengeWaitOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  isSessionOpen?: () => Promise<boolean>;
}

/**
 * Stores the public challenge, then waits until the student submits an answer
 * for this challenge id. The answer is deleted as soon as it is read.
 */
export async function publishAndWaitForChallenge(
  redis: ChallengeRedis,
  sessionId: string,
  challenge: VisionChallenge,
  options: ChallengeWaitOptions = {},
): Promise<ChallengeWaitResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? 250;
  const ttlSec = Math.max(1, Math.ceil((Date.parse(challenge.expiresAt) - now()) / 1000) + 30);
  await redis.set(visionChallengeKey(sessionId), JSON.stringify(challenge), 'EX', ttlSec);
  const answerKey = visionChallengeAnswerKey(sessionId, challenge.id);
  try {
    for (;;) {
      if (options.isSessionOpen && !(await options.isSessionOpen())) {
        return { status: 'session_expired' };
      }
      if (now() >= Date.parse(challenge.expiresAt)) return { status: 'timeout' };
      const answer = await redis.get(answerKey);
      if (answer) return { status: 'answer', answer };
      const remaining = Date.parse(challenge.expiresAt) - now();
      await sleep(Math.min(pollMs, Math.max(1, remaining)));
    }
  } finally {
    await redis.del(visionChallengeKey(sessionId), answerKey);
  }
}

export type ChallengeSubmitResult =
  | { ok: true; challengeId: string; kind: VisionChallengeKind }
  | { ok: false; reason: 'NONE' | 'EXPIRED' | 'SESSION_EXPIRED' };

/**
 * Accepts a student's answer for the challenge currently on screen.
 * The answer is stored under the challenge id and is not returned.
 */
export async function submitChallengeAnswer(
  redis: ChallengeRedis,
  sessionId: string,
  answer: string,
  options: { now?: number; sessionExpiresAt?: number } = {},
): Promise<ChallengeSubmitResult> {
  const now = options.now ?? Date.now();
  if (options.sessionExpiresAt != null && options.sessionExpiresAt <= now) {
    await redis.del(visionChallengeKey(sessionId));
    return { ok: false, reason: 'SESSION_EXPIRED' };
  }
  const raw = await redis.get(visionChallengeKey(sessionId));
  if (!raw) return { ok: false, reason: 'NONE' };
  let challenge: VisionChallenge;
  try {
    challenge = JSON.parse(raw) as VisionChallenge;
  } catch {
    await redis.del(visionChallengeKey(sessionId));
    return { ok: false, reason: 'NONE' };
  }
  if (!challenge.id || Date.parse(challenge.expiresAt) <= now) {
    await redis.del(visionChallengeKey(sessionId));
    return { ok: false, reason: 'EXPIRED' };
  }
  const ttlSec = Math.max(1, Math.ceil((Date.parse(challenge.expiresAt) - now) / 1000));
  await redis.set(visionChallengeAnswerKey(sessionId, challenge.id), answer, 'EX', ttlSec);
  await redis.del(visionChallengeKey(sessionId));
  return { ok: true, challengeId: challenge.id, kind: challenge.kind };
}

export async function readPendingChallenge(
  redis: ChallengeRedis,
  sessionId: string,
  now = Date.now(),
): Promise<VisionChallenge | null> {
  const raw = await redis.get(visionChallengeKey(sessionId));
  if (!raw) return null;
  try {
    const challenge = JSON.parse(raw) as VisionChallenge;
    if (!challenge?.id || Date.parse(challenge.expiresAt) <= now) {
      await redis.del(visionChallengeKey(sessionId));
      return null;
    }
    const kind = studentKind(challenge.kind);
    if (!kind) {
      await redis.del(visionChallengeKey(sessionId));
      return null;
    }
    return {
      id: challenge.id,
      kind,
      prompt: String(challenge.prompt ?? '').slice(0, 280),
      ...(challenge.imagePngBase64 ? { imagePngBase64: challenge.imagePngBase64 } : {}),
      expiresAt: challenge.expiresAt,
    };
  } catch {
    return null;
  }
}

function studentKind(value: unknown): VisionChallengeKind | null {
  return typeof value === 'string' && STUDENT_KINDS.has(value as VisionChallengeKind)
    ? (value as VisionChallengeKind)
    : null;
}

function fallbackPrompt(kind: VisionChallengeKind): string {
  if (kind === 'captcha') return 'Enter the characters shown in the captcha image.';
  if (kind === 'otp') return 'Enter the verification code.';
  if (kind === 'security_question') return 'Answer the security question.';
  return 'Enter the requested code.';
}
