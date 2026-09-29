/**
 * NestJS main API uses a global prefix of `api`, so internal routes live at
 * `/api/internal/...`. Agent services historically concatenated
 * `COURSE_REP_API_URL` (often `https://api.courserep.ng` with no `/api`) and
 * `/internal/...`, which 404s in production.
 *
 * Normalize so a missing `/api` still targets the real routes, without
 * producing `/api/api` when the env already includes the prefix.
 */
export function normalizeCourseRepApiUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  const url = new URL(trimmed);
  const path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/api')) {
    url.pathname = `${path}/api`;
  } else {
    url.pathname = path;
  }
  return url.toString().replace(/\/+$/, '');
}
