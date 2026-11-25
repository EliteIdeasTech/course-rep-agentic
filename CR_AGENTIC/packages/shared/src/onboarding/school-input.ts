/**
 * What a student typed where a school name was expected.
 *
 * Store pre-launch robots and confused students type their login email into
 * the school search. Those names must never start portal discovery.
 */
export type SchoolInputKind = 'empty' | 'email' | 'url' | 'phone' | 'name';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Any "@" with text on both sides is treated as an email-like value even
// without a TLD (e.g. "ada@unilag"). No real school name contains "@".
const AT_RE = /\S@\S/;
const URL_RE =
  /^(https?:\/\/)?(www\.)?([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i;
const PHONE_RE = /^\+?[\d\s().-]{7,}$/;

export function classifySchoolInput(raw: string | null | undefined): SchoolInputKind {
  const value = (raw ?? '').trim();
  if (!value) return 'empty';
  if (EMAIL_RE.test(value) || AT_RE.test(value)) return 'email';
  if (PHONE_RE.test(value) && (value.match(/\d/g)?.length ?? 0) >= 7) return 'phone';
  if (!/\s/.test(value) && URL_RE.test(value)) return 'url';
  return 'name';
}

/** True when a university name is really an email address. */
export function universityNameLooksLikeEmail(raw: string | null | undefined): boolean {
  return classifySchoolInput(raw) === 'email';
}
