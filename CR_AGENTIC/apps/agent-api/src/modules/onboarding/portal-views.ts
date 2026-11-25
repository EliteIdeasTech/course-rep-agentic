import type { HiddenPortalView, PortalCandidateView } from '@cr-agentic/shared';

/** API view of a stored candidate, including the student-facing label and host. */
export function candidateView(c: {
  id: string;
  loginUrl: string;
  lmsType: string;
  portalName: string | null;
  confidence: number;
  evidence: string[];
  source: string;
  metadata?: unknown;
}): PortalCandidateView {
  const meta = (c.metadata && typeof c.metadata === 'object' ? c.metadata : {}) as {
    label?: unknown;
    blockedFromServer?: unknown;
  };
  let host: string | undefined;
  try {
    host = new URL(c.loginUrl).hostname.replace(/^www\./, '');
  } catch {
    host = undefined;
  }
  return {
    id: c.id,
    loginUrl: c.loginUrl,
    lmsType: c.lmsType as PortalCandidateView['lmsType'],
    portalName: c.portalName ?? undefined,
    confidence: c.confidence,
    evidence: c.evidence,
    source: c.source as PortalCandidateView['source'],
    label: typeof meta.label === 'string' ? meta.label : undefined,
    host,
    blockedFromServer: meta.blockedFromServer === true ? true : undefined,
  };
}

/** Discovery stores `metadata.portalDiscovery.hidden`; the app shows "2 links hidden". */
export function hiddenPortalsFrom(metadata: unknown): HiddenPortalView[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const discovery = (metadata as { portalDiscovery?: { hidden?: unknown } }).portalDiscovery;
  const hidden = discovery?.hidden;
  if (!Array.isArray(hidden)) return [];
  return hidden
    .filter(
      (h): h is HiddenPortalView =>
        !!h &&
        typeof h === 'object' &&
        typeof (h as HiddenPortalView).host === 'string' &&
        typeof (h as HiddenPortalView).reason === 'string' &&
        typeof (h as HiddenPortalView).message === 'string',
    )
    .map((h) => ({ host: h.host, reason: h.reason, message: h.message }))
    .slice(0, 5);
}
