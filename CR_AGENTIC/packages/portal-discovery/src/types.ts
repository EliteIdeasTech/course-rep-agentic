import { LmsType } from '@cr-agentic/shared';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface PageMetadata {
  url: string;
  finalUrl: string;
  title?: string;
  hasLoginForm: boolean;
  htmlSample: string;
  /** HTTP status of the final response. Undefined when the fetch failed. */
  status?: number;
  /** Why the fetch failed (DNS, timeout, refused/reset, TLS, other). */
  fetchError?: PageFetchError;
}

export type PageFetchError = 'dns' | 'timeout' | 'connection' | 'tls' | 'other';

export interface PortalCandidateResult {
  loginUrl: string;
  portalName?: string;
  lmsType: LmsType;
  confidence: number;
  evidence: string[];
  /** Student-facing label, e.g. "Student portal" or "Moodle e-learning". */
  label?: string;
}

/** Why a URL found during discovery was not shown to the student. */
export type HiddenCandidateReason =
  | 'unreachable'
  | 'http_error'
  | 'no_login_signal'
  | 'other_country'
  | 'other_school'
  | 'cms_login';

export interface HiddenCandidate {
  url: string;
  host: string;
  reason: HiddenCandidateReason;
  /** Short student-facing sentence for the reason. */
  message: string;
}

export interface PortalDiscoveryResult {
  candidates: PortalCandidateResult[];
  hidden: HiddenCandidate[];
}

export interface DiscoverPortalInput {
  universityName: string;
  country?: string;
  website?: string;
  /** Promoted known-good portal after enough successful logins. */
  knownPortalUrl?: string;
}

/** Minimal completion contract so the package stays provider-agnostic. */
export interface LlmCompletionClient {
  completeJson(systemPrompt: string, userPrompt: string): Promise<string>;
}

/** Pluggable web search backend (Serper, Tavily, Bing, etc.). */
export interface WebSearchClient {
  search(query: string, limit?: number): Promise<WebSearchResult[]>;
}
