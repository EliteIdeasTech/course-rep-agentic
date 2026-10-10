import type { ElementSnapshot, VisionChallengeKind } from './types';

const PAY = /\b(pay|payment|checkout|pay\s*now|pay\s*fees|make\s+payment)\b/i;
const REGISTER = /\b(register\s+courses?|course\s+registration|submit\s+registration|add\s+courses?|drop\s+courses?)\b/i;
const DELETE = /\b(delete|remove|destroy)\b/i;
const SUBMIT = /\bsubmit\b/i;
const LOGIN = /\b(log\s*in|login|sign\s*in|sign-in)\b/i;
const CAPTCHA = /\b(captcha|recaptcha|hcaptcha|i['’]m not a robot)\b/i;
const OTP = /\b(otp|one[-\s]?time(?:\s+password)?|verification code|two[-\s]?factor|\b2fa\b|authenticator|security code)\b/i;
const SECURITY = /\b(security question|mother'?s maiden|name of your (?:first )?(?:pet|school)|city were you born|in what city)\b/i;

export type SafetyStop = 'BLOCKED';

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
  | { ok: false; pause: VisionChallengeKind; prompt: string }
  | { ok: false; reason: string };

export function actionBlob(ctx: Pick<SafetyContext, 'element' | 'intent'>): string {
  const el = ctx.element;
  return [ctx.intent, el?.text, el?.ariaLabel, el?.href, el?.role, el?.inputType]
    .filter((part) => !!part && part.trim())
    .join(' ');
}

/**
 * Login is the only form we may submit. Pay, course registration, delete,
 * and every other submit are refused. Captcha, OTP, and security questions
 * pause for the student instead of being solved or clicked through.
 */
export function classifyAction(ctx: SafetyContext): SafetyVerdict {
  const blob = actionBlob(ctx);
  const pause = challengeFromBlob(blob);
  if (pause) return { ok: false, pause: pause.kind, prompt: pause.prompt };

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

export function pageChallenge(text: string): { kind: VisionChallengeKind; prompt: string } | null {
  return challengeFromBlob(text);
}

function challengeFromBlob(text: string): { kind: VisionChallengeKind; prompt: string } | null {
  if (CAPTCHA.test(text)) {
    return { kind: 'captcha', prompt: lineFor(text, CAPTCHA, 'Enter the characters shown in the captcha image.') };
  }
  if (OTP.test(text)) {
    return { kind: 'otp', prompt: lineFor(text, OTP, 'Enter the verification code.') };
  }
  if (SECURITY.test(text)) {
    return { kind: 'security_question', prompt: lineFor(text, SECURITY, 'Answer the security question.') };
  }
  return null;
}

function lineFor(text: string, pattern: RegExp, fallback: string): string {
  const line = text
    .split(/\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0 && part.length <= 280 && pattern.test(part));
  return (line ?? fallback).slice(0, 280);
}
