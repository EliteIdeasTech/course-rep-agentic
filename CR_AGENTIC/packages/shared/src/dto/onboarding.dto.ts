import { LmsType } from './connect-lms.dto';

export enum OnboardingStage {
  UNIVERSITY_SELECTED = 'UNIVERSITY_SELECTED',
  PORTAL_DISCOVERING = 'PORTAL_DISCOVERING',
  PORTAL_SUGGESTED = 'PORTAL_SUGGESTED',
  PORTAL_CONFIRMED = 'PORTAL_CONFIRMED',
  AWAITING_LOGIN = 'AWAITING_LOGIN',
  LOGIN_IN_PROGRESS = 'LOGIN_IN_PROGRESS',
  SESSION_CAPTURED = 'SESSION_CAPTURED',
  DEEP_DISCOVERY = 'DEEP_DISCOVERY',
  ONBOARDING_COMPLETE = 'ONBOARDING_COMPLETE',
  REAUTH_REQUIRED = 'REAUTH_REQUIRED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}

export enum PortalCandidateSource {
  WEB_SEARCH = 'WEB_SEARCH',
  UNIVERSITY_CACHE = 'UNIVERSITY_CACHE',
  MANUAL = 'MANUAL',
  OPS_OVERRIDE = 'OPS_OVERRIDE',
}

export enum DiscoveryStatus {
  NOT_STARTED = 'NOT_STARTED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETE = 'COMPLETE',
  FAILED = 'FAILED',
}

export interface StartOnboardingDto {
  universityId?: string;
  /** Required unless `universityId` is set. The agent fills it from the main API when omitted. */
  universityName?: string;
  country?: string;
  website?: string;
  departmentName?: string;
  academicLevelName?: string;
}

export interface PortalCandidateView {
  id: string;
  loginUrl: string;
  lmsType: LmsType;
  portalName?: string;
  confidence: number;
  evidence: string[];
  source: PortalCandidateSource;
}

/**
 * Payload the mobile WebView posts back to the public login-bridge endpoint.
 * `storageState` is a Playwright-compatible storage state JSON captured from the
 * authenticated WebView (cookies + localStorage/origins).
 */
export interface LoginBridgePayload {
  sessionId: string;
  bridgeToken: string;
  storageState: {
    cookies: Array<Record<string, unknown>>;
    origins: Array<Record<string, unknown>>;
  };
}
