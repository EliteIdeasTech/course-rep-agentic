import { timingSafeEqual } from 'crypto';

/**
 * App Review sign-in for universities flagged `isDemo` on the main API.
 * The username is fixed. The password is `REVIEWER_PORTAL_PASSWORD` and is
 * compared in memory only — never persisted, logged, or sent to Playwright.
 */
export const REVIEWER_DEMO_USERNAME = 'appreview';

export const INVALID_CREDENTIALS_MESSAGE = 'Invalid credentials';

export const DEMO_INTERACTIVE_LOGIN_MESSAGE =
  'Interactive login is not available for this session';

/** Nest route. COURSE_REP_API_URL includes the global `/api` prefix in production. */
export const REVIEWER_DEMO_PROVISION_PATH = '/internal/reviewer-demo/provision';

export const REVIEWER_DEMO_ATTEMPT_LIMIT = 10;
export const REVIEWER_DEMO_ATTEMPT_WINDOW_SEC = 15 * 60;

const RATE_LIMIT_PREFIX = 'cr:agent:ratelimit:reviewer-demo:';

export function reviewerDemoRateLimitKey(userId: string): string {
  return `${RATE_LIMIT_PREFIX}${userId}`;
}

/**
 * True only when the main API university record has boolean `isDemo: true`.
 * Names, codes, and ids are ignored so a renamed or re-seeded school still works.
 */
export function universityIsDemo(university: unknown): boolean {
  if (!university || typeof university !== 'object' || Array.isArray(university)) {
    return false;
  }
  return (university as Record<string, unknown>).isDemo === true;
}

export function sessionIsDemo(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return false;
  }
  return (metadata as Record<string, unknown>).isDemo === true;
}

export function demoSessionMetadata(
  existing?: unknown,
): Record<string, unknown> {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  return { ...base, isDemo: true };
}

/**
 * Constant-time compare of two strings. Length is checked after the compare
 * so a different length does not throw and does not return early.
 */
export function timingSafeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  const length = Math.max(a.length, b.length, 1);
  const aa = Buffer.alloc(length);
  const bb = Buffer.alloc(length);
  a.copy(aa);
  b.copy(bb);
  const equal = timingSafeEqual(aa, bb);
  return equal && a.length === b.length;
}

/**
 * Matches username `appreview` and `REVIEWER_PORTAL_PASSWORD`.
 * An unset or empty password rejects every attempt.
 */
export function reviewerDemoCredentialsMatch(
  username: string,
  password: string,
  expectedPassword: string | undefined | null,
): boolean {
  const configured =
    typeof expectedPassword === 'string' && expectedPassword.length > 0;
  const userOk = timingSafeStringEqual(username, REVIEWER_DEMO_USERNAME);
  const passOk = timingSafeStringEqual(password, configured ? expectedPassword : ' ');
  return configured && userOk && passOk;
}

export interface DemoCredentialRateLimitStore {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

/**
 * Counts an attempt and reports whether it is still inside the window.
 * Callers should still run the credential compare so a limited attempt
 * does not skip the constant-time check.
 */
export async function consumeReviewerDemoAttempt(
  store: DemoCredentialRateLimitStore,
  userId: string,
  options?: { limit?: number; windowSec?: number },
): Promise<boolean> {
  const limit = options?.limit ?? REVIEWER_DEMO_ATTEMPT_LIMIT;
  const windowSec = options?.windowSec ?? REVIEWER_DEMO_ATTEMPT_WINDOW_SEC;
  const key = reviewerDemoRateLimitKey(userId);
  const count = await store.incr(key);
  if (count === 1) {
    await store.expire(key, windowSec);
  }
  return count <= limit;
}

export interface DemoProvisionCourse {
  code?: string | null;
  title?: string | null;
  units?: number | null;
  instructor?: string | null;
  offered?: boolean;
}

export interface CoursesToImport {
  userId: string;
  courses: Array<{
    code: string;
    title: string;
    units?: number;
    instructor?: string;
    offered: boolean;
  }>;
}

/**
 * Turns a provision response into an import-from-agent payload.
 * Courses the provision endpoint already enrolled are omitted when the
 * response has no course list.
 */
export function coursesToImportFromProvision(
  userId: string,
  provision: { courses?: DemoProvisionCourse[] | null } | null | undefined,
): CoursesToImport | null {
  const courses = provision?.courses;
  if (!Array.isArray(courses) || courses.length === 0) {
    return null;
  }

  const imported = courses.flatMap((course) => {
    const code = course.code?.trim();
    const title = course.title?.trim();
    if (!code || !title) return [];
    const row: CoursesToImport['courses'][number] = {
      code,
      title,
      offered: course.offered !== false,
    };
    if (typeof course.units === 'number') row.units = course.units;
    const instructor = course.instructor?.trim();
    if (instructor) row.instructor = instructor;
    return [row];
  });

  if (imported.length === 0) return null;
  return { userId, courses: imported };
}
