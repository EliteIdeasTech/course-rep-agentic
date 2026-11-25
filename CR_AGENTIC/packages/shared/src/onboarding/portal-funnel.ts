/**
 * Portal-connect funnel: step names, structured failure reasons, error
 * classification and sanitising. Pure functions only (no Prisma / Nest), shared
 * by agent-api, browser-worker and discovery-worker so every writer of
 * `onboarding_funnel_events` uses the same vocabulary.
 *
 * Never put portal usernames, passwords, OTPs, cookies or tokens into any value
 * produced here. `sanitizeFunnelMessage` and `sanitizeFunnelMetadata` are the
 * last line of defence, not the first: callers must not pass secrets at all.
 */

/** Ordered funnel steps. Index = how far the student got. */
export const FUNNEL_STEPS = [
  'school_picked',
  'portal_discovering',
  'portal_suggested',
  'portal_accepted',
  'awaiting_login',
  'credentials_submitted',
  'session_captured',
  'importing',
  'completed',
] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

export function funnelStepRank(step: string | null | undefined): number {
  return step ? FUNNEL_STEPS.indexOf(step as FunnelStep) : -1;
}

/** Stage (OnboardingStage enum value) -> funnel step. Terminal failure stages return null. */
export function funnelStepForStage(stage: string | null | undefined): FunnelStep | null {
  switch (stage) {
    case 'UNIVERSITY_SELECTED':
      return 'school_picked';
    case 'PORTAL_DISCOVERING':
      return 'portal_discovering';
    case 'PORTAL_SUGGESTED':
      return 'portal_suggested';
    case 'PORTAL_CONFIRMED':
      return 'portal_accepted';
    case 'AWAITING_LOGIN':
      return 'awaiting_login';
    case 'LOGIN_IN_PROGRESS':
      return 'credentials_submitted';
    case 'SESSION_CAPTURED':
      return 'session_captured';
    case 'DEEP_DISCOVERY':
      return 'importing';
    case 'ONBOARDING_COMPLETE':
      return 'completed';
    default:
      return null;
  }
}

/** Structured failure reasons recorded on `failed` / `cancelled` funnel events. */
export const FUNNEL_FAILURE_REASONS = [
  'start_failed',
  'login_rejected',
  'login_not_confirmed',
  'otp_required',
  'captcha_required',
  'sso_required',
  'interactive_required',
  'timeout',
  'portal_unreachable',
  'page_structure_changed',
  'import_empty',
  'session_expired',
  'no_portal_found',
  'rate_limited',
  'user_cancelled',
  'server_error',
  'client_error',
  'unknown',
] as const;
export type FunnelFailureReason = (typeof FUNNEL_FAILURE_REASONS)[number];

export function isFunnelFailureReason(v: unknown): v is FunnelFailureReason {
  return typeof v === 'string' && (FUNNEL_FAILURE_REASONS as readonly string[]).includes(v);
}

/** Event kinds stored in onboarding_funnel_events.event. */
export const FUNNEL_EVENTS = ['step', 'failed', 'cancelled', 'client'] as const;
export type FunnelEventKind = (typeof FUNNEL_EVENTS)[number];

/**
 * Client (mobile/web) event names accepted by POST /onboarding/:id/events.
 * Anything else is rejected so the endpoint cannot become a free-text sink.
 */
export const CLIENT_FUNNEL_EVENTS = [
  'school_picked',
  'portal_suggested_shown',
  'portal_accepted',
  'portal_manual_entered',
  'credentials_submitted',
  'start_failed',
  'login_failed',
  'login_poll_timeout',
  'interactive_login_opened',
  'interactive_login_closed',
  'otp_prompt_shown',
  'captcha_prompt_shown',
  'import_empty',
  'step_viewed',
  'screen_left',
  'start_over',
] as const;
export type ClientFunnelEvent = (typeof CLIENT_FUNNEL_EVENTS)[number];

export function isClientFunnelEvent(v: unknown): v is ClientFunnelEvent {
  return typeof v === 'string' && (CLIENT_FUNNEL_EVENTS as readonly string[]).includes(v);
}

/** Maps a browser-worker LoginFailureReason (login-outcome.ts) to a funnel reason. */
export function funnelReasonForLoginReason(reason: unknown, message?: string): FunnelFailureReason {
  switch (reason) {
    case 'invalid_credentials':
      return 'login_rejected';
    case 'not_authenticated':
      return 'login_not_confirmed';
    case 'captcha_required':
      return 'captcha_required';
    case 'mfa_required':
      return 'otp_required';
    case 'sso_required':
      return 'sso_required';
    case 'needs_interactive_login':
      return 'interactive_required';
    case 'login_form_not_found':
      return 'page_structure_changed';
    case 'portal_unreachable':
      return message && /timeout/i.test(message) ? 'timeout' : 'portal_unreachable';
    case 'credentials_expired':
      // Credentials sat in the queue past their 5-minute TTL.
      return 'timeout';
    case 'session_validation_failed':
      return 'session_expired';
    case 'credentials_decrypt_failed':
      return 'server_error';
    case 'credential_login_error':
      return classifyFunnelError({ message }).reason;
    default:
      return 'unknown';
  }
}

export interface ClassifiedFunnelError {
  errorClass: string;
  reason: FunnelFailureReason;
  message: string;
  httpStatus?: number;
}

/**
 * Turns any thrown value (or a {name,message,status} shape) into a structured,
 * sanitised failure. Order matters: HTTP status first, then message patterns.
 */
export function classifyFunnelError(err: unknown): ClassifiedFunnelError {
  const e = (err ?? {}) as {
    name?: unknown;
    message?: unknown;
    status?: unknown;
    statusCode?: unknown;
    constructor?: { name?: string };
    getStatus?: () => number;
  };
  let errorClass =
    (typeof e.name === 'string' && e.name !== 'Error' && e.name) ||
    (err instanceof Error && err.constructor?.name) ||
    (typeof e.name === 'string' && e.name) ||
    (typeof err === 'string' ? 'String' : 'Unknown');
  if (typeof errorClass !== 'string') errorClass = 'Unknown';
  const rawMessage =
    typeof e.message === 'string' ? e.message : typeof err === 'string' ? err : '';
  let status: number | undefined;
  try {
    const s =
      typeof e.getStatus === 'function'
        ? e.getStatus()
        : typeof e.status === 'number'
          ? e.status
          : typeof e.statusCode === 'number'
            ? e.statusCode
            : undefined;
    if (typeof s === 'number' && Number.isFinite(s)) status = s;
  } catch {
    status = undefined;
  }
  const message = sanitizeFunnelMessage(rawMessage);
  const reason = reasonFor(rawMessage, status, errorClass);
  return { errorClass: errorClass.slice(0, 80), reason, message, ...(status !== undefined ? { httpStatus: status } : {}) };
}

function reasonFor(msg: string, status: number | undefined, errorClass: string): FunnelFailureReason {
  if (status === 429) return 'rate_limited';
  if (status === 401 && /credential|password|username/i.test(msg)) return 'login_rejected';
  if (/TimeoutError/i.test(errorClass) || /timeout|timed out|ETIMEDOUT|ERR_TIMED_OUT/i.test(msg)) return 'timeout';
  if (/net::ERR_|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|getaddrinfo|socket hang up|ERR_SSL|certificate/i.test(msg))
    return 'portal_unreachable';
  if (/captcha|recaptcha|hcaptcha/i.test(msg)) return 'captcha_required';
  if (/\botp\b|one[- ]time|verification code|two[- ]factor|2fa|mfa/i.test(msg)) return 'otp_required';
  if (/waiting for (selector|locator)|locator\.|no (login )?form|element (is )?not (found|visible|attached)|strict mode violation|selector/i.test(msg))
    return 'page_structure_changed';
  if (/no (courses|course units)|import(ed)? 0|empty/i.test(msg)) return 'import_empty';
  if (/no portal|portal not found|no candidates/i.test(msg)) return 'no_portal_found';
  if (status !== undefined && status >= 500) return 'server_error';
  if (status !== undefined && status >= 400) return 'client_error';
  return 'unknown';
}

const MAX_MESSAGE = 300;

/**
 * Removes anything that could identify a student or authenticate as them:
 * emails, long digit runs (matric numbers, phones, OTPs), bearer/JWT tokens,
 * key=value secrets and URL query strings. Truncates to 300 chars.
 */
export function sanitizeFunnelMessage(input: unknown): string {
  if (typeof input !== 'string' || !input) return '';
  let s = input;
  s = s.replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]');
  s = s.replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[jwt]');
  s = s.replace(
    /\b(pass(word|wd)?|pwd|otp|pin|token|secret|code|cookie|session(id)?|username|user|matric(no)?|login)\b(\s*[:=]\s*|\s+)("[^"]*"|'[^']*'|\S+)/gi,
    '$1=[redacted]',
  );
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
  s = s.replace(/(https?:\/\/[^\s?#"']+)\?[^\s"']*/gi, '$1?[query]');
  s = s.replace(/\b[A-Za-z]{0,4}\/?\d{4,}[A-Za-z0-9/]*\b/g, '[number]');
  s = s.replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, '[blob]');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE - 1)}…` : s;
}

const SECRET_KEY = /pass|pwd|otp|pin|token|secret|cookie|session|auth|credential|username|matric|email|phone|code/i;
const ALLOWED_META_KEYS = 20;

/** Keeps only short primitive values with non-sensitive keys. */
export function sanitizeFunnelMetadata(meta: unknown): Record<string, string | number | boolean> | undefined {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    if (n >= ALLOWED_META_KEYS) break;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k) || SECRET_KEY.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = sanitizeFunnelMessage(v).slice(0, 120);
    else continue;
    n += 1;
  }
  return Object.keys(out).length ? out : undefined;
}

/** True when the university name looks like a test / demo / reviewer session. */
export function isTestSchoolName(name: string | null | undefined): boolean {
  if (!name) return true;
  const n = name.trim().toLowerCase();
  return (
    n.includes('@') ||
    /course rep demo|demo univ|\bdiagnostic\b|delete me|\btest\b|reviewer/.test(n) ||
    n.length < 4
  );
}

/** Canonical display key for a school name (case/space-insensitive). */
export function schoolKey(name: string | null | undefined): string {
  return (name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface FunnelSessionRow {
  sessionId: string;
  school: string;
  day: string; // YYYY-MM-DD (WAT)
  furthestStep: string | null;
  completed: boolean;
  reasons: string[]; // failure/cancel reasons for this session (may repeat)
  cancelledAtStep?: string | null;
}

export interface FunnelSummaryRow {
  school: string;
  day: string;
  started: number;
  reached: Record<FunnelStep, number>;
  completed: number;
  successRate: number; // completed / started, 0..1 rounded to 3dp
  cancelled: number;
  cancelledAtStep: Record<string, number>;
  topFailureReasons: { reason: string; sessions: number }[];
}

/**
 * Aggregates per-session rows into per (school, day) funnel rows. `reached[x]`
 * counts sessions whose furthest step is at or beyond x. Failure reasons count
 * sessions (not events), top 5.
 */
export function aggregateFunnel(rows: FunnelSessionRow[], opts: { byDay?: boolean } = {}): FunnelSummaryRow[] {
  const byDay = opts.byDay ?? true;
  const groups = new Map<string, { school: string; day: string; rows: FunnelSessionRow[] }>();
  const displayName = new Map<string, string>();
  for (const r of rows) {
    const sk = schoolKey(r.school);
    if (!displayName.has(sk) || /[A-Z]/.test(r.school)) displayName.set(sk, r.school.trim());
    const day = byDay ? r.day : 'all';
    const key = `${sk}|${day}`;
    if (!groups.has(key)) groups.set(key, { school: sk, day, rows: [] });
    groups.get(key)!.rows.push(r);
  }
  const out: FunnelSummaryRow[] = [];
  for (const g of groups.values()) {
    const reached = Object.fromEntries(FUNNEL_STEPS.map((s) => [s, 0])) as Record<FunnelStep, number>;
    const reasonSessions = new Map<string, number>();
    const cancelledAtStep: Record<string, number> = {};
    let completed = 0;
    let cancelled = 0;
    for (const r of g.rows) {
      const rank = funnelStepRank(r.furthestStep);
      FUNNEL_STEPS.forEach((s, i) => {
        if (rank >= i) reached[s] += 1;
      });
      if (r.completed) completed += 1;
      for (const reason of new Set(r.reasons)) {
        reasonSessions.set(reason, (reasonSessions.get(reason) ?? 0) + 1);
      }
      if (r.cancelledAtStep !== undefined && r.cancelledAtStep !== null) {
        cancelled += 1;
        cancelledAtStep[r.cancelledAtStep] = (cancelledAtStep[r.cancelledAtStep] ?? 0) + 1;
      }
    }
    const started = g.rows.length;
    out.push({
      school: displayName.get(g.school) ?? g.school,
      day: g.day,
      started,
      reached,
      completed,
      successRate: started ? Math.round((completed / started) * 1000) / 1000 : 0,
      cancelled,
      cancelledAtStep,
      topFailureReasons: [...reasonSessions.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([reason, sessions]) => ({ reason, sessions })),
    });
  }
  return out.sort((a, b) => (a.day === b.day ? b.started - a.started : a.day < b.day ? 1 : -1));
}
