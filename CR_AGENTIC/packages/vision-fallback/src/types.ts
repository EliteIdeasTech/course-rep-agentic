/** Placeholder the model is told to type. The executor swaps in the real password. */
export const PASSWORD_PLACEHOLDER = '{{CR_PORTAL_PASSWORD}}';

/**
 * Placeholder for an OTP, captcha, or security-question answer. The executor
 * swaps in the student's reply locally. The model never receives that reply.
 */
export const CHALLENGE_ANSWER_PLACEHOLDER = '{{CR_CHALLENGE_ANSWER}}';

/** Computer Use model from the Gemini Interactions API (browser environment). */
export const COMPUTER_USE_MODEL = 'gemini-3.8-flash';

/** Gemini 3.x computer-use coordinates are normalized to this grid. */
export const COORD_SCALE = 1000;

export const DEFAULT_MAX_STEPS = 25;
export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_TOKEN_BUDGET = 200_000;
/** How long a paused challenge waits for the student. */
export const DEFAULT_CHALLENGE_TIMEOUT_MS = 180_000;
export const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

/**
 * Introductory paid-tier rates for gemini-3.8-flash through 31 Dec 2026.
 * https://ai.google.dev/gemini-api/docs/pricing
 */
export const GEMINI_38_FLASH_USD_PER_MILLION = {
  input: 0.75,
  output: 3.75,
} as const;

export type VisionGoal = 'login_and_extract' | 'extract' | 'find_login_form';

export type VisionStatus =
  | 'SIGNED_IN'
  | 'CAPTURED'
  | 'LOGIN_FORM_FOUND'
  | 'AWAITING_USER_INPUT'
  | 'CHALLENGE_TIMEOUT'
  | 'SESSION_EXPIRED'
  | 'CAPTCHA_REQUIRED'
  | 'OTP_REQUIRED'
  | 'BUDGET_EXCEEDED'
  | 'TIMEOUT'
  | 'BLOCKED'
  | 'FAILED'
  | 'SKIPPED';

/** Same identity fields the scripted scraper stores on DiscoveredPortalProfile. */
export interface VisionProfile {
  displayName?: string;
  email?: string;
  studentId?: string;
  departmentName?: string;
  academicLevelName?: string;
}

/** Same course fields the scripted scraper stores on DiscoveredCourse. */
export interface VisionCourse {
  externalId: string;
  code?: string;
  title: string;
  units?: number;
  semester?: string;
  instructor?: string;
}

/** GPA fields stored on DiscoveredAcademicRecord when a results page is visible. */
export interface VisionResults {
  gpa?: number;
  cumulativeGpa?: number;
}

export interface VisionCapture {
  profile: VisionProfile;
  courses: VisionCourse[];
  results?: VisionResults;
}

export interface VisionLimits {
  maxSteps: number;
  timeoutMs: number;
  tokenBudget: number;
}

export interface VisionStepLog {
  step: number;
  action: string;
  intent?: string;
  url?: string;
  refused?: string;
  inputTokens: number;
  outputTokens: number;
}

export type VisionChallengeKind = 'otp' | 'captcha' | 'security_question' | 'other';

/** Shown to the student while the browser session is paused. No answer is included. */
export interface VisionChallenge {
  id: string;
  kind: VisionChallengeKind;
  prompt: string;
  imagePngBase64?: string;
  expiresAt: string;
}

export type ChallengeWaitResult =
  | { status: 'answer'; answer: string }
  | { status: 'timeout' }
  | { status: 'session_expired' };

export interface VisionRunResult {
  status: VisionStatus;
  capture: VisionCapture;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  latencyMs: number;
  logs: VisionStepLog[];
  stopReason?: string;
  /** Set when the run paused and no answer handler was attached. */
  challenge?: VisionChallenge;
}

export interface ElementSnapshot {
  text: string;
  ariaLabel: string;
  href: string;
  tag: string;
  inputType: string;
  role: string;
}

export interface ComputerSurface {
  viewport(): { width: number; height: number };
  url(): string;
  screenshot(): Promise<Buffer>;
  htmlExcerpt(maxChars: number): Promise<string>;
  elementAt(x: number, y: number): Promise<ElementSnapshot | null>;
  passwordFieldVisible(): Promise<boolean>;
  loginFormVisible(): Promise<boolean>;
  challengeVisible(): Promise<{ kind: VisionChallengeKind; prompt: string } | null>;
  /** Crop of the captcha or prompt control, when one is on screen. */
  cropChallenge?(): Promise<Buffer | null>;
  /** Click the input the student is being asked to fill. */
  focusChallenge?(kind: VisionChallengeKind): Promise<boolean>;
  /** Remember a secret so later screenshots can cover it. */
  noteSecret?(value: string): void;
  click(x: number, y: number, button?: 'left' | 'right' | 'middle', clickCount?: number): Promise<void>;
  move(x: number, y: number): Promise<void>;
  typeText(text: string, pressEnter: boolean): Promise<void>;
  scroll(x: number, y: number, direction: 'up' | 'down' | 'left' | 'right', pixels: number): Promise<void>;
  navigate(url: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  wait(ms: number): Promise<void>;
  pressKey(key: string): Promise<void>;
}

export interface ModelFunctionCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelTurn {
  id?: string;
  calls: ModelFunctionCall[];
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface FunctionResultInput {
  name: string;
  callId: string;
  url: string;
  error?: string;
  screenshotPngBase64: string;
}

export interface ComputerUseClient {
  nextAction(input: {
    goalPrompt: string;
    screenshotPngBase64: string;
    previousInteractionId?: string;
    functionResults?: FunctionResultInput[];
    htmlExcerpt?: string;
  }): Promise<ModelTurn>;
  extract(input: {
    screenshots: string[];
    htmlExcerpt: string;
  }): Promise<{ capture: VisionCapture; inputTokens: number; outputTokens: number }>;
}

export function emptyCapture(): VisionCapture {
  return { profile: {}, courses: [] };
}
