import type { ElementSnapshot } from './types';

const PAY = /\b(pay|payment|checkout|pay\s*now|pay\s*fees|make\s+payment)\b/i;
const REGISTER = /\b(register\s+courses?|course\s+registration|submit\s+registration|add\s+courses?|drop\s+courses?)\b/i;
const DELETE = /\b(delete|remove|destroy)\b/i;
const SUBMIT = /\bsubmit\b/i;
const LOGIN = /\b(log\s*in|login|sign\s*in|sign-in)\b/i;
const CAPTCHA = /\b(captcha|recaptcha|hcaptcha|i['’]m not a robot)\b/i;
const OTP = /\b(otp|one[-\s]?time password|verification code|two[-\s]?factor|\b2fa\b)\b/i;

export type SafetyStop = 'CAPTCHA_REQUIRED' | 'OTP_REQUIRED';

export interface SafetyContext {
  passwordVisible: boolean;
  allowTyping: boolean;
  element: ElementSnapshot | null;
  intent: string;
  actionName: string;
}

export type SafetyVerdict =
  | { ok: true }
  | { ok: false; stop: SafetyStop }
  | { ok: false; reason: string };

export function actionBlob(ctx: Pick<SafetyContext, 'element' | 'intent'>): string {
  const el = ctx.element;
  return [ctx.intent, el?.text, el?.ariaLabel, el?.href, el?.role, el?.inputType]
    .filter((part) => !!part && part.trim())
    .join(' ');
}

/**
 * Login is the only form we may submit. Pay, course registration, delete,
 * and every other submit are refused. Captcha and OTP stop the run.
 */
export function classifyAction(ctx: SafetyContext): SafetyVerdict {
  const blob = actionBlob(ctx);
  if (CAPTCHA.test(blob)) return { ok: false, stop: 'CAPTCHA_REQUIRED' };
  if (OTP.test(blob)) return { ok: false, stop: 'OTP_REQUIRED' };

  if (ctx.actionName === 'type' && !ctx.allowTyping) {
    return { ok: false, reason: 'typing is not allowed for this goal' };
  }

  const clicking = ctx.actionName === 'click' || ctx.actionName === 'double_click' || ctx.actionName === 'triple_click';
  if (!clicking && ctx.actionName !== 'type') return { ok: true };

  if (PAY.test(blob)) return { ok: false, reason: 'refused pay action' };
  if (REGISTER.test(blob)) return { ok: false, reason: 'refused course registration action' };
  if (DELETE.test(blob)) return { ok: false, reason: 'refused delete action' };

  const loginSubmit = ctx.passwordVisible && LOGIN.test(blob);
  if (SUBMIT.test(blob) && !loginSubmit) {
    return { ok: false, reason: 'refused submit outside login' };
  }
  return { ok: true };
}

export function pageChallenge(text: string): 'captcha' | 'otp' | null {
  if (CAPTCHA.test(text)) return 'captcha';
  if (OTP.test(text)) return 'otp';
  return null;
}
