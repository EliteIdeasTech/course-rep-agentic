import { LmsType } from '@cr-agentic/shared';
import type {
  DiscoverPortalInput,
  HiddenCandidate,
  LlmCompletionClient,
  PageMetadata,
  PortalCandidateResult,
  PortalDiscoveryResult,
  WebSearchClient,
} from './types';
import { fetchPageMetadata } from './tools/page-metadata';
import { classifyLms } from './tools/classify-lms';
import {
  HIDDEN_REASON_MESSAGES,
  hostOf,
  portalLabel,
  verifyCandidate,
} from './verify';

type SeedSource = 'known' | 'website_guess' | 'search' | 'llm';

type Enriched = {
  meta: PageMetadata;
  lms: ReturnType<typeof classifyLms>;
  heuristic: number;
  source: SeedSource;
};

/** Max LLM-proposed URLs we will open to verify (they are never shown unverified). */
const MAX_LLM_FETCHES = 5;
/** LLM rank only nudges ordering between verified candidates. */
const LLM_TIEBREAK_MAX = 0.05;

const SYSTEM_PROMPT = `You are an assistant that identifies the official student login portal for a university.
You are given web search results and fetched page metadata.
Return STRICT JSON of the form:
{"candidates":[{"loginUrl":"https://...","portalName":"...","lmsType":"CANVAS|MOODLE|BLACKBOARD|BRIGHTSPACE|GOOGLE_CLASSROOM|GENERIC","confidence":0.0,"evidence":["..."]}]}
Rank by likelihood the URL is the real student academic login portal.
Strongly prefer: studentportal.*, portal.*, students.*, LMS hosts (lms/canvas/moodle/blackboard), and paths like /portal/login.
Strongly avoid: WordPress/CMS auth (wp-login.php, /wp-admin), marketing/news/seminar pages, and bare homepages.
Prefer official university domains (.edu, .ac.*, .edu.ng). confidence is between 0 and 1.
Return at most 5 candidates, highest confidence first.`;

const ACADEMIC_TLD_RE = /\.(edu|ac\.[a-z]{2}|edu\.[a-z]{2})(\/|$)/i;
const CMS_AUTH_RE =
  /\/wp-login\.php(?:$|\?)|\/wp-admin(?:\/|$)|\/xmlrpc\.php(?:$|\?)|\/user\/login(?:$|\?).*drupal/i;
const PORTAL_HOST_RE =
  /^(studentportal|students|student|portal|myportal|sis|erp)\./i;
const LMS_HOST_RE = /^(lms|canvas|moodle|blackboard|brightspace|elearning|e-learning)\./i;
const CONTENT_PATH_RE =
  /\/(blog|news|seminar|events?|about|admission|wp-content|category|tag)(\/|$)/i;

export class PortalDiscoveryService {
  constructor(
    private readonly search: WebSearchClient,
    private readonly llm: LlmCompletionClient,
    /** Fetch enough seeds that studentportal.* is not dropped when homepage probes expand. */
    private readonly maxPagesToFetch = 12,
  ) {}

  /** Verified candidates only. Use {@link discoverDetailed} for hidden reasons. */
  async discover(input: DiscoverPortalInput): Promise<PortalCandidateResult[]> {
    return (await this.discoverDetailed(input)).candidates;
  }

  /**
   * Opens every URL before it can be suggested. Unverified URLs (dead DNS,
   * errors, no sign-in page, another country's or school's domain) go to
   * `hidden` with a student-facing reason. The LLM can propose URLs, but they
   * are fetched and verified like any other and its ranking is a tie-breaker.
   */
  async discoverDetailed(input: DiscoverPortalInput): Promise<PortalDiscoveryResult> {
    const query = `${input.universityName} student portal login${input.country ? ' ' + input.country : ''}`;
    const results = await this.search.search(query, 8).catch(() => []);

    // Priority seeds first so slice(0, maxPagesToFetch) keeps known + studentportal.* URLs.
    const seeds = new Map<string, SeedSource>();
    if (input.knownPortalUrl) seeds.set(input.knownPortalUrl, 'known');
    for (const url of this.websiteSeedUrls(input.website)) {
      if (!seeds.has(url)) seeds.set(url, 'website_guess');
    }
    for (const r of results) if (!seeds.has(r.url)) seeds.set(r.url, 'search');

    const picked = Array.from(seeds.entries()).slice(0, this.maxPagesToFetch);
    const metas = await Promise.all(picked.map(([url]) => fetchPageMetadata(url)));
    const enriched: Enriched[] = metas.map((meta, i) => this.enrich(meta, picked[i][1]));

    // LLM proposals: fetch the ones we have not opened yet, then verify them too.
    let llmRank = new Map<string, number>();
    let portalNames = new Map<string, string>();
    try {
      const llmCandidates = await this.rankWithLlm(input, enriched);
      const seen = new Set(enriched.flatMap((e) => [e.meta.url, e.meta.finalUrl]));
      const toFetch = llmCandidates
        .map((c) => c.loginUrl)
        .filter((u) => !seen.has(u))
        .slice(0, MAX_LLM_FETCHES);
      const extra = await Promise.all(toFetch.map((u) => fetchPageMetadata(u)));
      for (const meta of extra) enriched.push(this.enrich(meta, 'llm'));
      llmRank = new Map(llmCandidates.map((c, i) => [c.loginUrl, i] as const));
      portalNames = new Map(
        llmCandidates.filter((c) => c.portalName).map((c) => [c.loginUrl, c.portalName!] as const),
      );
    } catch {
      // LLM is optional: verification + heuristics decide on their own.
    }

    const school = {
      universityName: input.universityName,
      country: input.country,
      website: input.website,
      knownPortalUrl: input.knownPortalUrl,
    };

    const verified: PortalCandidateResult[] = [];
    const hidden: HiddenCandidate[] = [];
    const seenKeys = new Set<string>();

    for (const e of enriched) {
      const key = e.meta.finalUrl.replace(/\/+$/, '').toLowerCase();
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const check = verifyCandidate(e.meta, e.lms.lmsType, school);
      if (!check.verified) {
        if (this.worthReportingHidden(e)) {
          const reason = check.hiddenReason ?? 'no_login_signal';
          hidden.push({
            url: e.meta.url,
            host: hostOf(e.meta.finalUrl) || hostOf(e.meta.url),
            reason,
            message: HIDDEN_REASON_MESSAGES[reason],
          });
        }
        continue;
      }

      const rank = llmRank.get(e.meta.url) ?? llmRank.get(e.meta.finalUrl);
      const tiebreak = rank === undefined ? 0 : Math.max(0, LLM_TIEBREAK_MAX - rank * 0.01);
      const base = Math.max(e.heuristic, 0.2);
      const confidence = Math.min(1, Number((base + tiebreak).toFixed(2)));
      verified.push({
        loginUrl: e.meta.finalUrl,
        portalName: portalNames.get(e.meta.url) ?? portalNames.get(e.meta.finalUrl) ?? e.meta.title,
        label: portalLabel(e.meta.finalUrl, e.lms.lmsType, e.meta.title),
        lmsType: e.lms.lmsType,
        confidence,
        evidence: [...check.evidence, ...this.buildEvidence(e.meta, e.lms)].filter(
          (v, i, all) => all.indexOf(v) === i,
        ),
      });
    }

    verified.sort((a, b) => b.confidence - a.confidence);
    return {
      candidates: verified.slice(0, 5),
      hidden: this.dedupeHidden(hidden).slice(0, 5),
    };
  }

  private enrich(meta: PageMetadata, source: SeedSource): Enriched {
    return { meta, lms: classifyLms(meta), heuristic: this.heuristicScore(meta), source };
  }

  /**
   * Website guesses (portal.<domain>, /portal/login, …) fail often by design;
   * only report links a student or the AI would actually have seen.
   */
  private worthReportingHidden(e: Enriched): boolean {
    if (e.source === 'known' || e.source === 'llm') return true;
    if (e.source === 'website_guess') return false;
    return this.scoreUrlOnly(e.meta.url) >= 0.2 || /portal|login|student|lms|moodle|sis/i.test(e.meta.url);
  }

  private dedupeHidden(hidden: HiddenCandidate[]): HiddenCandidate[] {
    const byHost = new Map<string, HiddenCandidate>();
    for (const h of hidden) if (!byHost.has(h.host)) byHost.set(h.host, h);
    return Array.from(byHost.values());
  }

  /**
   * Probe common student-portal hosts first (e.g. studentportal.unilag.edu.ng/login),
   * then LMS hosts, then weaker same-origin paths that often redirect to WordPress.
   */
  private websiteSeedUrls(website?: string): string[] {
    if (!website) return [];
    try {
      const base = new URL(website);
      const host = base.hostname.replace(/^www\./i, '');
      const origin = base.origin;
      return [
        `https://studentportal.${host}/login`,
        `https://studentportal.${host}`,
        `https://students.${host}/login`,
        `https://students.${host}`,
        `https://student.${host}/login`,
        `https://student.${host}`,
        `https://portal.${host}/login`,
        `https://portal.${host}`,
        `https://myportal.${host}/login`,
        `https://myportal.${host}`,
        `${origin}/portalplus/`,
        `${origin}/portalplus/login`,
        `${origin}/portal/login`,
        `${origin}/portal/`,
        `${origin}/portal`,
        `${origin}/studentportal`,
        `https://lms.${host}`,
        `https://elearning.${host}`,
        `https://canvas.${host}`,
        `https://moodle.${host}`,
        `https://blackboard.${host}`,
        // Weaker: often CMS login on the marketing site.
        `${origin}/login`,
        `${origin}/student`,
        website,
      ];
    } catch {
      return [website];
    }
  }

  private heuristicScore(meta: PageMetadata): number {
    const url = meta.finalUrl;
    if (CMS_AUTH_RE.test(url)) return 0.05;

    // Failed fetch / empty body — do not promote invented DNS seeds.
    if (!meta.htmlSample && !meta.hasLoginForm && !meta.title) return 0.02;

    let host = '';
    let path = '/';
    try {
      const u = new URL(url);
      host = u.hostname.replace(/^www\./i, '');
      path = u.pathname || '/';
    } catch {
      return 0;
    }

    const title = meta.title ?? '';
    if (/404|403|forbidden|not found|bad gateway|error/i.test(title)) {
      return 0.08;
    }

    let score = 0;
    if (ACADEMIC_TLD_RE.test(url)) score += 0.15;

    if (PORTAL_HOST_RE.test(host)) score += 0.35;
    else if (LMS_HOST_RE.test(host)) score += 0.35;

    if (/\/portalplus(\/|$)/i.test(path)) score += 0.25;

    if (/\/login\/?$/i.test(path) && (PORTAL_HOST_RE.test(host) || LMS_HOST_RE.test(host))) {
      score += 0.15;
    } else if (/\/(portal|studentportal|students)(\/|$)/i.test(path)) {
      score += 0.12;
    } else if (/login|signin|sso|auth/i.test(path)) {
      score += 0.06;
    }

    // Live password form is strongest, but many NG student portals are JS apps
    // with no password field in the initial HTML (UNILAG/COOU/YabaTech).
    if (meta.hasLoginForm) {
      score += 0.4;
    } else if (PORTAL_HOST_RE.test(host) || LMS_HOST_RE.test(host)) {
      if (title && !/404|403|forbidden|not found|bad gateway|error/i.test(title)) {
        score += 0.2;
      } else {
        score -= 0.1;
      }
    } else {
      score -= 0.25;
    }

    if (CONTENT_PATH_RE.test(path)) score -= 0.35;
    if ((path === '/' || path === '') && !(PORTAL_HOST_RE.test(host) || LMS_HOST_RE.test(host))) {
      score -= 0.15;
    }

    return Math.max(0, Math.min(1, score));
  }

  private scoreUrlOnly(url: string): number {
    return this.heuristicScore({
      url,
      finalUrl: url,
      hasLoginForm: false,
      htmlSample: '',
    });
  }

  private buildEvidence(
    meta: PageMetadata,
    lms: ReturnType<typeof classifyLms>,
  ): string[] {
    const evidence: string[] = [];
    if (ACADEMIC_TLD_RE.test(meta.finalUrl)) evidence.push('academic domain');
    try {
      const host = new URL(meta.finalUrl).hostname.replace(/^www\./i, '');
      if (PORTAL_HOST_RE.test(host)) evidence.push('student portal host');
      if (LMS_HOST_RE.test(host)) evidence.push('lms host');
    } catch {
      // ignore
    }
    if (/login|portal|sso|student|signin|auth/i.test(meta.finalUrl)) {
      evidence.push('login keyword in URL');
    }
    if (meta.hasLoginForm) evidence.push('login form detected');
    if (CMS_AUTH_RE.test(meta.finalUrl)) evidence.push('cms auth url');
    if (lms.matchedSignal) evidence.push(`lms signal: ${lms.matchedSignal}`);
    return evidence;
  }

  private async rankWithLlm(
    input: DiscoverPortalInput,
    enriched: Array<{
      meta: PageMetadata;
      lms: ReturnType<typeof classifyLms>;
      heuristic: number;
    }>,
  ): Promise<PortalCandidateResult[]> {
    const context = enriched.map((e) => ({
      url: e.meta.finalUrl,
      title: e.meta.title,
      hasLoginForm: e.meta.hasLoginForm,
      detectedLms: e.lms.lmsType,
      heuristicScore: e.heuristic,
    }));

    const userPrompt = JSON.stringify({
      university: input.universityName,
      country: input.country,
      website: input.website,
      pages: context,
    });

    const raw = await this.llm.completeJson(SYSTEM_PROMPT, userPrompt);
    const parsed = this.parseJson(raw);
    const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];

    return candidates
      .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object')
      .map((c) => this.normalizeCandidate(c))
      .filter((c): c is PortalCandidateResult => c !== null)
      .slice(0, 5);
  }

  private normalizeCandidate(
    c: Record<string, unknown>,
  ): PortalCandidateResult | null {
    const loginUrl = typeof c.loginUrl === 'string' ? c.loginUrl : null;
    if (!loginUrl) return null;
    const lmsType = this.coerceLmsType(c.lmsType);
    const confidence = typeof c.confidence === 'number' ? c.confidence : 0.5;
    return {
      loginUrl,
      portalName: typeof c.portalName === 'string' ? c.portalName : undefined,
      lmsType,
      confidence: Math.max(0, Math.min(1, confidence)),
      evidence: Array.isArray(c.evidence)
        ? c.evidence.filter((e): e is string => typeof e === 'string')
        : [],
    };
  }

  private coerceLmsType(value: unknown): LmsType {
    if (typeof value === 'string' && value.toUpperCase() in LmsType) {
      return LmsType[value.toUpperCase() as keyof typeof LmsType];
    }
    return LmsType.GENERIC;
  }

  private parseJson(raw: string): { candidates?: unknown[] } | null {
    try {
      return JSON.parse(raw);
    } catch {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(raw.slice(start, end + 1));
        } catch {
          return null;
        }
      }
      return null;
    }
  }
}
