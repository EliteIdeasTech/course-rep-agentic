import { OnboardingStage } from '../dto/onboarding.dto';

/**
 * Allowed onboarding stage transitions, mirroring the standalone onboarding
 * plan's state diagram. Pure and framework-agnostic so both agent-api and the
 * discovery worker share one source of truth.
 */
const TRANSITIONS: Record<OnboardingStage, OnboardingStage[]> = {
  [OnboardingStage.UNIVERSITY_SELECTED]: [
    OnboardingStage.PORTAL_DISCOVERING,
    OnboardingStage.CANCELLED,
    OnboardingStage.FAILED,
  ],
  [OnboardingStage.PORTAL_DISCOVERING]: [
    OnboardingStage.PORTAL_SUGGESTED,
    OnboardingStage.FAILED,
    OnboardingStage.CANCELLED,
  ],
  [OnboardingStage.PORTAL_SUGGESTED]: [
    OnboardingStage.PORTAL_DISCOVERING,
    OnboardingStage.PORTAL_CONFIRMED,
    OnboardingStage.CANCELLED,
    OnboardingStage.FAILED,
  ],
  [OnboardingStage.PORTAL_CONFIRMED]: [
    OnboardingStage.AWAITING_LOGIN,
    OnboardingStage.CANCELLED,
    OnboardingStage.FAILED,
  ],
  [OnboardingStage.AWAITING_LOGIN]: [
    OnboardingStage.LOGIN_IN_PROGRESS,
    OnboardingStage.REAUTH_REQUIRED,
    // Reviewer demo sessions (university isDemo) finish here. They never
    // open a portal or run Playwright.
    OnboardingStage.ONBOARDING_COMPLETE,
    OnboardingStage.CANCELLED,
    OnboardingStage.FAILED,
  ],
  [OnboardingStage.LOGIN_IN_PROGRESS]: [
    OnboardingStage.SESSION_CAPTURED,
    OnboardingStage.REAUTH_REQUIRED,
    OnboardingStage.FAILED,
    OnboardingStage.CANCELLED,
  ],
  [OnboardingStage.SESSION_CAPTURED]: [
    OnboardingStage.DEEP_DISCOVERY,
    OnboardingStage.CANCELLED,
    OnboardingStage.FAILED,
  ],
  [OnboardingStage.DEEP_DISCOVERY]: [
    OnboardingStage.ONBOARDING_COMPLETE,
    OnboardingStage.FAILED,
    OnboardingStage.CANCELLED,
  ],
  [OnboardingStage.REAUTH_REQUIRED]: [
    OnboardingStage.AWAITING_LOGIN,
    OnboardingStage.CANCELLED,
    OnboardingStage.FAILED,
  ],
  [OnboardingStage.ONBOARDING_COMPLETE]: [],
  [OnboardingStage.CANCELLED]: [],
  [OnboardingStage.FAILED]: [],
};

const TERMINAL_STAGES: string[] = [
  OnboardingStage.ONBOARDING_COMPLETE,
  OnboardingStage.CANCELLED,
  OnboardingStage.FAILED,
];

export function canTransitionStage(from: string, to: string): boolean {
  if (from === to) return true;
  return (TRANSITIONS[from as OnboardingStage] ?? []).includes(
    to as OnboardingStage,
  );
}

export function isTerminalStage(stage: string): boolean {
  return TERMINAL_STAGES.includes(stage);
}
