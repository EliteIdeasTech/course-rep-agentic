/**
 * University lookup for onboarding demo detection.
 *
 * The main API wraps handler results as `{ success, data, ... }` unless the
 * handler uses `@SkipResponseTransform()`. `isDemo` lives on the university
 * row inside `data`, not on the wrapper. Public lists omit demo rows. Public
 * GET-by-id currently includes them, but that is not the contract to rely on.
 *
 * Preferred route (not shipped on the main API yet):
 * `GET /api/internal/universities/:id` with `X-Internal-Secret`, including
 * demo rows and `isDemo`. Until that route exists it 404s, and the client
 * falls back to public `GET /universities/:id`.
 */

export const INTERNAL_UNIVERSITY_BY_ID_PREFIX = '/internal/universities/';
export const PUBLIC_UNIVERSITY_BY_ID_PREFIX = '/universities/';

export function internalUniversityPath(universityId: string): string {
  return `${INTERNAL_UNIVERSITY_BY_ID_PREFIX}${encodeURIComponent(universityId)}`;
}

export function publicUniversityPath(universityId: string): string {
  return `${PUBLIC_UNIVERSITY_BY_ID_PREFIX}${encodeURIComponent(universityId)}`;
}

/** Only a missing internal route should try the public GET. Auth and 5xx stay failed. */
export function shouldFallbackUniversityLookup(status: number | undefined): boolean {
  return status === 404;
}

export function httpStatusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * University row from either a raw entity or the main API success envelope.
 * Names and ids are not used to decide demo status.
 */
export function universityRecord(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  if (body.success === true && isRecord(body.data)) {
    return body.data;
  }
  return body;
}

/**
 * True when the university row has boolean `isDemo: true`.
 * Numeric `1` is accepted because `universities.isDemo` is a MySQL tinyint;
 * the public JSON serializer currently sends a boolean, but a raw `1` must
 * not be treated as a normal school. Strings and other values stay false.
 */
export function universityIsDemo(university: unknown): boolean {
  const record = universityRecord(university);
  if (!record) return false;
  return record.isDemo === true || record.isDemo === 1;
}

/** Display name stored on the onboarding session when the client omits one. */
export function universityDisplayName(university: unknown): string | undefined {
  const record = universityRecord(university);
  const name = record?.name;
  if (typeof name !== 'string') return undefined;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Client-supplied name wins. A missing or blank name is filled from the
 * loaded university row.
 */
export function resolveOnboardingUniversityName(
  provided: string | null | undefined,
  university: unknown,
): string | undefined {
  if (typeof provided === 'string') {
    const trimmed = provided.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return universityDisplayName(university);
}

/**
 * `universityName` is required unless `universityId` is present and the name
 * was omitted. A provided name is still type-checked so the mobile payload
 * (`universityId` + `universityName`) keeps validating.
 */
export function universityNameMustBeValidated(dto: {
  universityId?: string | null;
  universityName?: unknown;
}): boolean {
  const hasId = typeof dto.universityId === 'string' && dto.universityId.length > 0;
  const nameOmitted = dto.universityName === undefined || dto.universityName === null;
  return !(hasId && nameOmitted);
}
