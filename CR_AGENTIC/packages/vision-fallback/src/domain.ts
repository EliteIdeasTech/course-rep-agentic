/**
 * School-agnostic host allowlist. Navigation may stay on the portal's
 * registrable domain (and its subdomains) and nowhere else.
 */
const MULTI_PART_SUFFIXES = [
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.ng',
  'edu.ng',
  'org.ng',
  'gov.ng',
  'net.ng',
  'sch.ng',
  'ac.ng',
  'com.au',
  'edu.au',
  'co.za',
  'ac.za',
  'com.gh',
  'edu.gh',
  'co.ke',
  'ac.ke',
  'com.br',
  'co.in',
  'ac.in',
];

export function registrableDomain(hostname: string): string {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return '';
  if (host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  const match = MULTI_PART_SUFFIXES.find((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  const parts = host.split('.');
  if (match) {
    const extra = match.split('.').length + 1;
    return parts.slice(-extra).join('.');
  }
  if (parts.length <= 2) return host;
  return parts.slice(-2).join('.');
}

export interface DomainDecision {
  ok: boolean;
  reason?: string;
  resolved?: string;
}

export function isNavigationAllowed(target: string, portalUrl: string, currentUrl?: string): DomainDecision {
  let resolved: URL;
  try {
    const base = currentUrl || portalUrl;
    resolved = new URL(target, base);
  } catch {
    return { ok: false, reason: 'unparseable url' };
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    return { ok: false, reason: `blocked protocol ${resolved.protocol}`, resolved: resolved.toString() };
  }
  const allowed = registrableDomain(new URL(portalUrl).hostname);
  const next = registrableDomain(resolved.hostname);
  if (!allowed || allowed !== next) {
    return {
      ok: false,
      reason: `host ${resolved.hostname} is outside ${allowed || 'the portal domain'}`,
      resolved: resolved.toString(),
    };
  }
  return { ok: true, resolved: resolved.toString() };
}
