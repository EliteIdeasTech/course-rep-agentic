/**
 * Why a server-side portal login did not capture a session. Written by the
 * browser worker into the onboarding audit event `detail.reason` and turned
 * into a student-facing status by the agent API.
 */
export type LoginFailureReason =
  | 'invalid_credentials'
  | 'captcha_required'
  | 'sso_required'
  | 'mfa_required'
  | 'login_form_not_found'
  | 'not_authenticated'
  | 'credentials_expired'
  | 'credentials_decrypt_failed'
  | 'credential_login_error'
  | 'session_validation_failed'
  | 'needs_interactive_login';

export interface LoginOutcomeInfo {
  /** Stable machine code for clients. */
  errorCode: string;
  /** Short, student-facing explanation. */
  message: string;
  /** True when the student should sign in themselves in the in-app browser. */
  interactiveRequired: boolean;
  /** True when re-entering username/password may work. */
  canRetryCredentials: boolean;
}

export const LOGIN_OUTCOMES: Record<LoginFailureReason, LoginOutcomeInfo> = {
  invalid_credentials: {
    errorCode: 'INVALID_CREDENTIALS',
    message:
      'Your school portal said the username or password is wrong. Check them and try again.',
    interactiveRequired: false,
    canRetryCredentials: true,
  },
  captcha_required: {
    errorCode: 'CAPTCHA_REQUIRED',
    message:
      'Your school portal asks for a captcha, so we can\'t sign in for you. Please sign in to your portal yourself in the next screen.',
    interactiveRequired: true,
    canRetryCredentials: false,
  },
  sso_required: {
    errorCode: 'SSO_REQUIRED',
    message:
      'Your school uses a single sign-on page (for example Microsoft or Google). Please sign in to your portal yourself in the next screen.',
    interactiveRequired: true,
    canRetryCredentials: false,
  },
  mfa_required: {
    errorCode: 'MFA_REQUIRED',
    message:
      'Your school portal asked for an extra verification code. Please sign in to your portal yourself in the next screen.',
    interactiveRequired: true,
    canRetryCredentials: false,
  },
  login_form_not_found: {
    errorCode: 'LOGIN_FORM_NOT_FOUND',
    message:
      'We couldn\'t find the sign-in form on your school portal. Please sign in to your portal yourself in the next screen.',
    interactiveRequired: true,
    canRetryCredentials: false,
  },
  not_authenticated: {
    errorCode: 'LOGIN_NOT_CONFIRMED',
    message:
      'We couldn\'t confirm the sign-in. Please sign in to your portal yourself in the next screen.',
    interactiveRequired: true,
    canRetryCredentials: true,
  },
  credentials_expired: {
    errorCode: 'CREDENTIALS_EXPIRED',
    message: 'That sign-in attempt timed out. Please enter your portal details again.',
    interactiveRequired: false,
    canRetryCredentials: true,
  },
  credentials_decrypt_failed: {
    errorCode: 'CREDENTIALS_EXPIRED',
    message: 'That sign-in attempt timed out. Please enter your portal details again.',
    interactiveRequired: false,
    canRetryCredentials: true,
  },
  credential_login_error: {
    errorCode: 'PORTAL_ERROR',
    message:
      'Your school portal didn\'t respond properly. Please sign in to your portal yourself in the next screen, or try again later.',
    interactiveRequired: true,
    canRetryCredentials: true,
  },
  session_validation_failed: {
    errorCode: 'LOGIN_NOT_CONFIRMED',
    message:
      'We couldn\'t confirm the sign-in. Please sign in to your portal yourself again.',
    interactiveRequired: true,
    canRetryCredentials: false,
  },
  needs_interactive_login: {
    errorCode: 'INTERACTIVE_REQUIRED',
    message: 'Please sign in to your portal yourself in the next screen.',
    interactiveRequired: true,
    canRetryCredentials: false,
  },
};

export function loginOutcomeFor(reason: unknown): LoginOutcomeInfo | null {
  if (typeof reason !== 'string') return null;
  return (LOGIN_OUTCOMES as Record<string, LoginOutcomeInfo>)[reason] ?? null;
}

/** Max credential submissions per onboarding session per hour. */
export const CREDENTIAL_LOGIN_MAX_ATTEMPTS = 5;
export const CREDENTIAL_LOGIN_ATTEMPT_WINDOW_SEC = 60 * 60;
