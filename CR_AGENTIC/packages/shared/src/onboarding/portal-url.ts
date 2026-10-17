/**
 * Portal URL helpers shared by the agent API and discovery worker.
 * School-agnostic: students type URLs like "portal.school.edu/portalplus",
 * " https://WWW.School.edu/login/ ", or paste them with stray spaces.
 */

/**
 * Turns free-form portal input into an absolute URL: trims, removes
 * whitespace, adds https:// when there is no scheme, lowercases the host.
 * Path and query are kept as typed. Returns null when it is not a usable
 * http(s) URL with a dotted public host.
 */
export function normalizePortalUrl(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  let raw = input.trim().replace(/\s+/g, '');
  if (!raw) return null;
  // "//host/path" and "https:/host" style slips.
  raw = raw.replace(/^\/\//, '');
  raw = raw.replace(/^(https?):\/*(?=[^/])/i, (_m, scheme: string) => `${scheme.toLowerCase()}://`);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  // Needs a dotted public host. Loopback, private and link-local addresses
  // are refused so a typed URL can never point our server at itself.
  if (!host || !host.includes('.') || isPrivateHost(host)) return null;
  if (/^\.|\.\.|\.$/.test(host)) return null;
  url.hostname = host;
  url.hash = '';
  return url.toString();
}

/**
 * Comparison key: host without "www.", path without trailing slashes or a
 * trailing index file, lowercased; scheme, query and hash ignored. Two inputs
 * that point at the same portal page get the same key.
 */
export function portalMatchKey(input: string | null | undefined): string | null {
  const normalized = normalizePortalUrl(input);
  if (!normalized) return null;
  const url = new URL(normalized);
  const host = url.hostname.replace(/^www\./, '');
  const port = url.port && url.port !== '80' && url.port !== '443' ? `:${url.port}` : '';
  let path = decodeURIComponentSafe(url.pathname).toLowerCase().replace(/\/+$/, '');
  path = path.replace(/\/(index\.(php|html?|aspx?))$/, '');
  return `${host}${port}${path}`;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  if (host.startsWith('[')) return true; // IPv6 literals
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
