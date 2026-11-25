/**
 * Sessions from App Review, Play pre-launch robots, Firebase Test Lab and staff
 * must not count as students in onboarding metrics.
 *
 * Tagging never blocks a session; it only writes `metadata.testAccount`.
 */
export type TestAccountReason =
  | 'test_lab'
  | 'reviewer'
  | 'staff'
  | 'example_domain'
  | 'demo_university'
  | 'client_flag';

export interface TestAccountTag {
  isTest: true;
  reason: TestAccountReason;
}

/** Header the mobile app sets when it knows the device/account is a test one. */
export const TEST_ACCOUNT_HEADER = 'x-cr-test-account';

const CLIENT_REASONS: ReadonlySet<string> = new Set([
  'test_lab',
  'reviewer',
  'staff',
  'example_domain',
]);
const STAFF_DOMAINS = ['courserep.ng', 'courserep.org', 'courserep.com'];
const EXAMPLE_DOMAINS = ['example.com', 'example.org', 'example.net', 'test.com'];

/** App Review / Play reviewer logins: appreview*, reviewerapp*. */
export function isReviewerIdentity(value: string | null | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v.startsWith('appreview') || v.startsWith('reviewerapp');
}

export function classifyTestEmail(
  email: string | null | undefined,
  extraEmails: readonly string[] = [],
): TestAccountReason | null {
  const mail = (email ?? '').trim().toLowerCase();
  if (!mail.includes('@')) return null;
  if (extraEmails.map((e) => e.trim().toLowerCase()).includes(mail)) return 'staff';
  if (isReviewerIdentity(mail)) return 'reviewer';
  const domain = mail.slice(mail.lastIndexOf('@') + 1);
  if (EXAMPLE_DOMAINS.includes(domain)) return 'example_domain';
  if (STAFF_DOMAINS.includes(domain)) return 'staff';
  return null;
}

/**
 * Combines what the server knows (demo school, email) with the client hint.
 * Unknown client hints are ignored so a header cannot write arbitrary data.
 */
export function classifyTestAccount(input: {
  clientHint?: string | null;
  email?: string | null;
  isDemoUniversity?: boolean;
  extraEmails?: readonly string[];
}): TestAccountTag | null {
  if (input.isDemoUniversity) return { isTest: true, reason: 'demo_university' };
  const fromEmail = classifyTestEmail(input.email, input.extraEmails);
  if (fromEmail) return { isTest: true, reason: fromEmail };
  const hint = (input.clientHint ?? '').trim().toLowerCase();
  if (hint && CLIENT_REASONS.has(hint)) {
    return { isTest: true, reason: hint as TestAccountReason };
  }
  if (hint === '1' || hint === 'true') return { isTest: true, reason: 'client_flag' };
  return null;
}

/** For metrics queries: true when session metadata carries a test tag. */
export function sessionIsTestAccount(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const tag = (metadata as { testAccount?: unknown }).testAccount;
  return !!tag && typeof tag === 'object' && (tag as { isTest?: unknown }).isTest === true;
}
