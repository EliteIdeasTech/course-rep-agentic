import { LmsType } from '@cr-agentic/shared';
import type { HiddenCandidateReason, PageMetadata } from './types';

/**
 * Verified-only portal suggestions.
 *
 * A URL is shown to a student only when we opened it and it:
 *  1. resolved and answered (no DNS/connection failure, no 404/5xx),
 *  2. looks like a sign-in page (password form, LMS fingerprint, or a portal
 *     host such as studentportal.* that renders a real page; many Nigerian
 *     portals are JS apps with no password field in the first HTML), and
 *  3. belongs to the school: same country ccTLD, the school's own website or
 *     known portal domain, or a generic-TLD host that carries the school's name.
 *
 * The LLM never adds a URL by itself; it only breaks ties between verified ones.
 */

/** Country name (as stored in the main API catalog) → ccTLD. */
const COUNTRY_TLD: Record<string, string> = {
  nigeria: 'ng', ghana: 'gh', kenya: 'ke', uganda: 'ug', tanzania: 'tz',
  'tanzania, united republic of': 'tz', rwanda: 'rw', 'south africa': 'za',
  egypt: 'eg', ethiopia: 'et', cameroon: 'cm', 'sierra leone': 'sl', liberia: 'lr',
  gambia: 'gm', senegal: 'sn', zambia: 'zm', zimbabwe: 'zw', malawi: 'mw',
  botswana: 'bw', namibia: 'na', morocco: 'ma', tunisia: 'tn', algeria: 'dz',
  "cote d'ivoire": 'ci', 'ivory coast': 'ci', benin: 'bj', togo: 'tg', niger: 'ne',
  mozambique: 'mz', sudan: 'sd', somalia: 'so', angola: 'ao', 'burkina faso': 'bf',
  mali: 'ml', 'united kingdom': 'uk', 'great britain': 'uk', ireland: 'ie',
  canada: 'ca', australia: 'au', 'new zealand': 'nz', india: 'in', pakistan: 'pk',
  bangladesh: 'bd', 'sri lanka': 'lk', nepal: 'np', malaysia: 'my', singapore: 'sg',
  indonesia: 'id', philippines: 'ph', thailand: 'th', vietnam: 'vn', 'viet nam': 'vn',
  china: 'cn', japan: 'jp', 'korea, republic of': 'kr', 'south korea': 'kr',
  turkey: 'tr', 'türkiye': 'tr', turkiye: 'tr', jordan: 'jo', lebanon: 'lb',
  'saudi arabia': 'sa', 'united arab emirates': 'ae', qatar: 'qa', kuwait: 'kw',
  oman: 'om', bahrain: 'bh', iran: 'ir', 'iran, islamic republic of': 'ir', iraq: 'iq',
  israel: 'il', 'russian federation': 'ru', russia: 'ru', ukraine: 'ua', poland: 'pl',
  germany: 'de', france: 'fr', spain: 'es', italy: 'it', portugal: 'pt',
  netherlands: 'nl', belgium: 'be', switzerland: 'ch', austria: 'at', sweden: 'se',
  norway: 'no', denmark: 'dk', finland: 'fi', bulgaria: 'bg', romania: 'ro',
  hungary: 'hu', 'czech republic': 'cz', czechia: 'cz', greece: 'gr', cyprus: 'cy',
  brazil: 'br', mexico: 'mx', argentina: 'ar', chile: 'cl', colombia: 'co', peru: 'pe',
  jamaica: 'jm', 'trinidad and tobago': 'tt', barbados: 'bb', bahamas: 'bs',
};

/** Countries whose universities mostly use generic TLDs (.edu/.com/.org). */
const GENERIC_TLD_COUNTRIES = new Set(['united states', 'usa', 'united states of america']);

/** Generic TLDs: allowed anywhere, but must carry the school's name. */
const GENERIC_TLDS = new Set([
  'com', 'org', 'net', 'edu', 'info', 'app', 'io', 'online', 'site', 'school',
  'education', 'academy', 'college', 'university', 'cloud', 'tech', 'me', 'ai',
]);

/** Hosted LMS/SIS vendors. The school's name must appear in the subdomain. */
const SAAS_HOST_RE =
  /(^|\.)(instructure\.com|moodlecloud\.com|blackboard\.com|brightspace\.com|d2l\.com|campusgroups\.com|myschoolapp\.com|edupage\.org|classroom\.google\.com|3dtechnologiesllc\.com|powerschool\.com|schoology\.com)$/i;

const PORTAL_HOST_RE = /^(studentportal|students|student|portal|myportal|sis|erp|eportal|e-portal|my)\./i;
const LMS_HOST_RE = /^(lms|canvas|moodle|blackboard|brightspace|elearning|e-learning|vle|learn)\./i;
const ERROR_TITLE_RE = /404|403|forbidden|not found|bad gateway|error|unavailable/i;
const CMS_AUTH_RE =
  /\/wp-login\.php(?:$|\?)|\/wp-admin(?:\/|$)|\/xmlrpc\.php(?:$|\?)|\/user\/login(?:$|\?).*drupal/i;

const NAME_STOPWORDS = new Set([
  'the', 'of', 'and', 'for', 'in', 'at', 'de', 'la', 'le', 'du', 'des', 'di', 'da',
  'university', 'universite', 'universidad', 'universitas', 'college', 'institute',
  'school', 'polytechnic', 'technical', 'technology', 'state', 'federal', 'national',
  'academy', 'faculty', 'campus', 'sciences', 'science', 'studies', 'medical',
  'education', 'higher', 'arts', 'management', 'business', 'complex', 'sports',
]);

export interface SchoolIdentity {
  universityName: string;
  country?: string;
  website?: string;
  knownPortalUrl?: string;
}

export interface VerificationResult {
  verified: boolean;
  hiddenReason?: HiddenCandidateReason;
  /** Reached, but the portal blocks our servers (401/403/429/503). */
  blockedFromServer: boolean;
  evidence: string[];
}

export const HIDDEN_REASON_MESSAGES: Record<HiddenCandidateReason, string> = {
  unreachable: "This link didn't open.",
  http_error: 'This page returned an error.',
  no_login_signal: 'No sign-in page was found here.',
  other_country: 'This portal belongs to a school in another country.',
  other_school: "This looks like a different school's site.",
  cms_login: 'This is the website admin login, not the student portal.',
};

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function countryTld(country?: string): string | undefined {
  if (!country) return undefined;
  return COUNTRY_TLD[country.trim().toLowerCase()];
}

function lastLabel(host: string): string {
  const parts = host.split('.');
  return parts[parts.length - 1] ?? '';
}

/** Registrable-ish domain: last two labels, or three for edu.ng / ac.uk style. */
export function baseDomain(host: string): string {
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const sld = parts[parts.length - 2];
  const second = /^(edu|ac|co|com|org|gov|net|sch)$/.test(sld) && lastLabel(host).length === 2;
  return parts.slice(second ? -3 : -2).join('.');
}

/** Name tokens used to tell whether a generic-TLD host belongs to the school. */
export function schoolTokens(universityName: string): string[] {
  const words = universityName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const significant = words.filter((w) => w.length >= 3 && !NAME_STOPWORDS.has(w));
  const tokens = new Set<string>();
  for (const w of significant) {
    if (w.length >= 4) tokens.add(w);
    tokens.add(`uni${w.slice(0, 3)}`); // unilag, uniben, unical
  }
  const allInitials = words.filter((w) => !['the', 'of', 'and', 'for', 'in', 'at', 'de'].includes(w)).map((w) => w[0]).join('');
  const sigInitials = significant.map((w) => w[0]).join('');
  if (allInitials.length >= 2) tokens.add(allInitials);
  if (sigInitials.length >= 2) tokens.add(sigInitials);
  return Array.from(tokens);
}

export function hostMatchesSchool(host: string, universityName: string): boolean {
  const labels = host.split('.');
  const compact = host.replace(/[.-]/g, '');
  for (const token of schoolTokens(universityName)) {
    if (token.length >= 4 && compact.includes(token)) return true;
    if (token.length >= 2 && token.length < 4) {
      // Short acronyms must be a whole label or a label prefix/suffix (htu, htuedu).
      if (labels.some((l) => l === token || (l.length <= token.length + 4 && (l.startsWith(token) || l.endsWith(token))))) {
        return true;
      }
    }
  }
  return false;
}

/** Country/domain ownership check. Returns the hidden reason or null when it belongs. */
export function ownershipProblem(
  url: string,
  school: SchoolIdentity,
): 'other_country' | 'other_school' | null {
  const host = hostOf(url);
  if (!host) return 'other_school';

  const own = [school.website, school.knownPortalUrl]
    .map((u) => (u ? baseDomain(hostOf(u.startsWith('http') ? u : `https://${u}`)) : ''))
    .filter(Boolean);
  if (own.includes(baseDomain(host))) return null;

  const nameMatch = hostMatchesSchool(host, school.universityName);
  if (SAAS_HOST_RE.test(host)) return nameMatch ? null : 'other_school';

  const tld = lastLabel(host);
  const expected = countryTld(school.country);
  const countryKey = (school.country ?? '').trim().toLowerCase();

  if (GENERIC_TLDS.has(tld)) {
    if (tld === 'edu' && GENERIC_TLD_COUNTRIES.has(countryKey)) return nameMatch ? null : 'other_school';
    return nameMatch ? null : 'other_school';
  }

  // Two-letter ccTLD.
  if (expected) {
    if (tld === expected) return null;
    return 'other_country';
  }
  if (GENERIC_TLD_COUNTRIES.has(countryKey)) return 'other_country';
  // Country unknown or unmapped: accept academic ccTLD hosts that carry the name.
  return nameMatch ? null : 'other_school';
}

function loginSignal(meta: PageMetadata, lmsType: LmsType): string | null {
  if (meta.hasLoginForm) return 'login form detected';
  if (lmsType !== LmsType.GENERIC) return `lms: ${lmsType.toLowerCase()}`;
  const host = hostOf(meta.finalUrl);
  const title = meta.title ?? '';
  const realPage = !!meta.htmlSample && !ERROR_TITLE_RE.test(title);
  let path = '/';
  try {
    path = new URL(meta.finalUrl).pathname;
  } catch {
    // ignore
  }
  if (realPage && (PORTAL_HOST_RE.test(host) || LMS_HOST_RE.test(host))) return 'portal host page';
  if (realPage && /\/(portalplus|studentportal|portal)(\/|$)/i.test(path)) return 'portal path page';
  if (realPage && /\b(log ?in|sign ?in|student portal|matric|reg(istration)? ?(no|number))\b/i.test(`${title} ${meta.htmlSample.slice(0, 5000)}`) &&
      /<input[^>]+(type=["']?(text|email|number)|name=["']?(user|login|matric|regno|email))/i.test(meta.htmlSample)) {
    return 'sign-in fields';
  }
  return null;
}

/** Runs all checks on one fetched page. */
export function verifyCandidate(
  meta: PageMetadata,
  lmsType: LmsType,
  school: SchoolIdentity,
): VerificationResult {
  const evidence: string[] = [];
  if (CMS_AUTH_RE.test(meta.finalUrl)) {
    return { verified: false, hiddenReason: 'cms_login', blockedFromServer: false, evidence };
  }
  if (meta.fetchError || (meta.status === undefined && !meta.htmlSample)) {
    return { verified: false, hiddenReason: 'unreachable', blockedFromServer: false, evidence };
  }

  const ownership = ownershipProblem(meta.finalUrl, school);
  if (ownership) {
    return { verified: false, hiddenReason: ownership, blockedFromServer: false, evidence };
  }
  evidence.push('school domain');

  const status = meta.status ?? 200;
  const blocked = [401, 403, 429, 503].includes(status);
  if (status >= 400 && !blocked) {
    return { verified: false, hiddenReason: 'http_error', blockedFromServer: false, evidence };
  }
  evidence.push(blocked ? 'blocked from our servers' : 'opens');

  if (blocked) {
    // Geo/anti-bot block on the school's own portal host: still worth showing,
    // the student signs in on their phone instead.
    const host = hostOf(meta.finalUrl);
    if (PORTAL_HOST_RE.test(host) || LMS_HOST_RE.test(host) || meta.hasLoginForm) {
      return { verified: true, blockedFromServer: true, evidence };
    }
    return { verified: false, hiddenReason: 'http_error', blockedFromServer: true, evidence };
  }

  const signal = loginSignal(meta, lmsType);
  if (!signal) {
    return { verified: false, hiddenReason: 'no_login_signal', blockedFromServer: false, evidence };
  }
  evidence.push(signal);
  return { verified: true, blockedFromServer: false, evidence };
}

const LMS_LABELS: Partial<Record<LmsType, string>> = {
  [LmsType.CANVAS]: 'Canvas',
  [LmsType.MOODLE]: 'Moodle e-learning',
  [LmsType.BLACKBOARD]: 'Blackboard',
  [LmsType.BRIGHTSPACE]: 'Brightspace',
  [LmsType.GOOGLE_CLASSROOM]: 'Google Classroom',
};

/** Human label instead of a raw URL: "Student portal", "Moodle e-learning", or a cleaned page title. */
export function portalLabel(url: string, lmsType: LmsType, title?: string): string {
  const lms = LMS_LABELS[lmsType];
  if (lms) return lms;
  const host = hostOf(url);
  let path = '/';
  try {
    path = new URL(url).pathname;
  } catch {
    // ignore
  }
  if (/^sis\./i.test(host)) return 'Student information system';
  if (/^erp\./i.test(host)) return 'Student ERP portal';
  if (LMS_HOST_RE.test(host)) return 'E-learning portal';
  if (/\/portalplus(\/|$)/i.test(path)) return 'PortalPlus student portal';
  if (PORTAL_HOST_RE.test(host)) return 'Student portal';
  const cleaned = (title ?? '')
    .split(/\s[|•·–—-]\s|::/)[0]
    .replace(/\b(log ?in|sign ?in|login page|welcome to)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (cleaned.length >= 3 && cleaned.length <= 60 && !ERROR_TITLE_RE.test(cleaned)) return cleaned;
  return 'Student portal';
}
