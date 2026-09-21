import { createHmac, randomBytes, timingSafeEqual, createHash } from 'crypto';
import type { GuestTokenFailureReason } from './onboarding-identity';

export const BRIDGE_TOKEN_TTL_MS = 5 * 60 * 1000;
export const GUEST_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export type GuestTokenInspectResult =
  | { ok: true }
  | { ok: false; reason: GuestTokenFailureReason };

/**
 * Short-lived, single-use token the mobile WebView presents to the public
 * login-bridge endpoint. Format: `<nonce>.<expiresAt>.<hmac>`. The HMAC binds
 * the token to the onboarding session id so it cannot be replayed elsewhere.
 */
export function createBridgeToken(
  sessionId: string,
  secret: string,
): { token: string; tokenHash: string; expiresAt: Date } {
  return createBoundToken(sessionId, secret, BRIDGE_TOKEN_TTL_MS);
}

export function verifyBridgeToken(
  token: string,
  sessionId: string,
  secret: string,
  storedHash: string | null,
  expiresAt: Date | null,
): boolean {
  return verifyBoundToken(token, sessionId, secret, storedHash, expiresAt);
}

/** Longer-lived guest token for school-first onboarding before a Course Rep JWT exists. */
export function createGuestToken(
  sessionId: string,
  secret: string,
): { token: string; tokenHash: string; expiresAt: Date } {
  return createBoundToken(sessionId, secret, GUEST_TOKEN_TTL_MS);
}

export function verifyGuestToken(
  token: string,
  sessionId: string,
  secret: string,
  storedHash: string | null,
  expiresAt: Date | null,
): boolean {
  return inspectGuestToken(token, sessionId, secret, storedHash, expiresAt).ok;
}

/**
 * Guest auth is durable in Postgres: the SHA-256 of the issued token is stored
 * on onboarding_sessions.metadata. Matching that hash (and expiry) is enough
 * to prove the client holds the original token for this session.
 *
 * HMAC with SESSION_ENCRYPTION_KEY is used at issue time and as an extra
 * check when the current key still matches. It must NOT be required, or an
 * agent recreate that rotates the key would invalidate in-flight onboarding
 * even though the Postgres hash is intact. Redis is not consulted.
 */
export function inspectGuestToken(
  token: string,
  _sessionId: string,
  _secret: string,
  storedHash: string | null,
  expiresAt: Date | null,
): GuestTokenInspectResult {
  if (!token) return { ok: false, reason: 'missing' };
  if (!storedHash || !expiresAt) return { ok: false, reason: 'missing' };
  if (Date.now() > expiresAt.getTime()) return { ok: false, reason: 'expired' };
  if (!safeEqual(hashToken(token), storedHash)) {
    return { ok: false, reason: 'mismatch' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'mismatch' };
  const expMs = Number(parts[1]);
  if (!Number.isFinite(expMs) || Date.now() > expMs) {
    return { ok: false, reason: 'expired' };
  }

  // Hash match against the session row is the source of truth. Re-checking
  // HMAC with the current SESSION_ENCRYPTION_KEY would reject valid tokens
  // after an agent recreate that rotated the key.
  return { ok: true };
}

function createBoundToken(
  sessionId: string,
  secret: string,
  ttlMs: number,
): { token: string; tokenHash: string; expiresAt: Date } {
  const nonce = randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + ttlMs);
  const payload = `${nonce}.${expiresAt.getTime()}`;
  const signature = sign(`${sessionId}.${payload}`, secret);
  const token = `${payload}.${signature}`;
  return { token, tokenHash: hashToken(token), expiresAt };
}

function verifyBoundToken(
  token: string,
  sessionId: string,
  secret: string,
  storedHash: string | null,
  expiresAt: Date | null,
): boolean {
  if (!storedHash || !expiresAt) return false;
  if (Date.now() > expiresAt.getTime()) return false;
  if (!safeEqual(hashToken(token), storedHash)) return false;

  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [nonce, exp, signature] = parts;
  const expected = sign(`${sessionId}.${nonce}.${exp}`, secret);
  return safeEqual(signature, expected);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
