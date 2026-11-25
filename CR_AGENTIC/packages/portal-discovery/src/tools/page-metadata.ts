import type { PageFetchError, PageMetadata } from '../types';

const TITLE_RE = /<title[^>]*>([^<]*)<\/title>/i;
const LOGIN_FORM_RE = /<form[^>]*>[\s\S]*?(type=["']?password|name=["']?(password|passwd|pwd))/i;

/**
 * Fetches a candidate URL and extracts lightweight metadata used for ranking.
 * Only a bounded HTML sample is retained for LMS fingerprinting downstream.
 */
export async function fetchPageMetadata(
  url: string,
  timeoutMs = 8000,
): Promise<PageMetadata> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'CourseRepAgent/1.0 (+portal-discovery)' },
    });
    const html = (await res.text()).slice(0, 200_000);
    return {
      url,
      finalUrl: res.url || url,
      title: TITLE_RE.exec(html)?.[1]?.trim(),
      hasLoginForm: LOGIN_FORM_RE.test(html),
      htmlSample: html.slice(0, 20_000),
      status: res.status,
    };
  } catch (err) {
    return {
      url,
      finalUrl: url,
      hasLoginForm: false,
      htmlSample: '',
      fetchError: classifyFetchError(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Maps undici/Node fetch errors to a small set of reasons. */
export function classifyFetchError(err: unknown): PageFetchError {
  const e = err as { name?: string; code?: string; cause?: { code?: string; name?: string } } | null;
  const code = e?.cause?.code ?? e?.code ?? '';
  const name = e?.name ?? e?.cause?.name ?? '';
  if (name === 'AbortError' || name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return 'timeout';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (/^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_SOCKET)$/.test(code)) {
    return 'connection';
  }
  if (/CERT|SSL|TLS/i.test(code)) return 'tls';
  return 'other';
}
