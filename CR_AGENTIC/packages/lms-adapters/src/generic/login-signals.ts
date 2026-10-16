import type { Page } from 'playwright-core';

/**
 * Heuristics for why an automated portal sign-in cannot proceed. Pure text
 * helpers are exported separately so they can be unit tested without a browser.
 */

const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="captcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="challenges.cloudflare.com"]',
  '.g-recaptcha',
  '.h-captcha',
  '.cf-turnstile',
  '[data-sitekey]',
  'input[name*="captcha" i]:not([type="hidden"])',
  'input[id*="captcha" i]:not([type="hidden"])',
  'img[src*="captcha" i]',
  'img[id*="captcha" i]',
  'img[alt*="captcha" i]',
  'img[class*="captcha" i]',
  'canvas[id*="captcha" i]',
];

const CAPTCHA_TEXT =
  /\b(captcha|security code|verification image|enter the (characters|code) (shown|you see|in the image)|type the (characters|text) (shown|in the image))\b|güvenlik kodu|doğrulama kodu|resimdeki/i;

const SSO_HOSTS =
  /(^|\.)(login\.microsoftonline\.com|login\.live\.com|accounts\.google\.com|okta\.com|auth0\.com|onelogin\.com)$/i;
const SSO_PATHS = /\/(cas\/login|saml2?\/|adfs\/|idp\/profile|shibboleth|simplesaml)/i;
const SSO_BUTTON_TEXT =
  /sign in with (microsoft|google|office ?365|your (school|university|institution) account)|log ?in with (microsoft|google|office ?365)|single sign[- ]on|continue with microsoft/i;

const INVALID_CREDENTIAL_PATTERNS: RegExp[] = [
  /invalid (username|user ?name|user id|login|email|matric(ulation)? (number|no)|credentials?|password|details|combination)[^.\n]{0,60}/i,
  /(username|user ?name|password|login|credentials?|matric(ulation)? (number|no)|email)[^.\n]{0,40}\b(is|are) (incorrect|invalid|wrong|not correct)[^.\n]{0,40}/i,
  /(incorrect|wrong) (username|user ?name|password|login|credentials?|details|matric(ulation)? (number|no))[^.\n]{0,60}/i,
  /(username|password|credentials?)[^.\n]{0,20}(do(es)?n['’]?t|do(es)? not) match[^.\n]{0,40}/i,
  /\b(authentication|login|sign[- ]?in) (failed|unsuccessful)[^.\n]{0,60}/i,
  /\b(unable|failed) to (log ?in|sign ?in|authenticate)[^.\n]{0,60}/i,
  /\b(user|account|student|record) (not found|does not exist|doesn['’]t exist)[^.\n]{0,40}/i,
  /\b(matric(ulation)?|student|reg(istration)?) (number|no\.?|id)[^.\n]{0,30}(does not exist|doesn['’]t exist|not found|is invalid|not recogni[sz]ed)/i,
  /\bbad credentials\b/i,
  /kullanıcı adı[^.\n]{0,40}(hatalı|yanlış|geçersiz)|şifre[^.\n]{0,40}(hatalı|yanlış|geçersiz)|(hatalı|geçersiz) (kullanıcı|şifre|parola)/i,
];

/** Return the first invalid-credential message that appears in `after` but not in `before`. */
export function findNewInvalidCredentialText(before: string, after: string): string | null {
  const beforeLines = new Set(
    before
      .split(/\n+/)
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean),
  );
  const newText = after
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l && !beforeLines.has(l.toLowerCase()))
    .join('\n');
  for (const re of INVALID_CREDENTIAL_PATTERNS) {
    const m = newText.match(re);
    if (m) return m[0].trim().slice(0, 120);
  }
  return null;
}

export function isSsoUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    if (SSO_HOSTS.test(u.hostname)) return `host:${u.hostname}`;
    if (SSO_PATHS.test(u.pathname)) return `path:${u.pathname.slice(0, 60)}`;
  } catch {
    // ignore
  }
  return null;
}

export function hasCaptchaText(text: string): boolean {
  return CAPTCHA_TEXT.test(text);
}

export async function bodyText(page: Page): Promise<string> {
  return ((await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '')) || '').slice(0, 20_000);
}

/** Returns a short marker name when a captcha is present on the page, else null. */
export async function detectCaptcha(page: Page): Promise<string | null> {
  for (const sel of CAPTCHA_SELECTORS) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) > 0) return sel;
  }
  // Text label next to a form ("Security code", "Güvenlik Kodu").
  const forms = page.locator('form');
  const n = Math.min(await forms.count().catch(() => 0), 5);
  for (let i = 0; i < n; i++) {
    const t = await forms.nth(i).innerText({ timeout: 2_000 }).catch(() => '');
    if (t && hasCaptchaText(t)) return 'form_text';
  }
  return null;
}

/** Returns a short marker when the page is (or only offers) an SSO sign-in, else null. */
export async function detectSso(page: Page): Promise<string | null> {
  const byUrl = isSsoUrl(page.url());
  if (byUrl) return byUrl;
  const hasPassword = (await page.locator('input[type="password"]').count().catch(() => 0)) > 0;
  if (hasPassword) return null;
  const clickable = page.locator('a, button, input[type="submit"], input[type="button"]');
  const n = Math.min(await clickable.count().catch(() => 0), 80);
  for (let i = 0; i < n; i++) {
    const el = clickable.nth(i);
    const t =
      (await el.innerText({ timeout: 500 }).catch(() => '')) ||
      (await el.getAttribute('value').catch(() => '')) ||
      '';
    if (SSO_BUTTON_TEXT.test(t)) return 'sso_button';
  }
  return null;
}
