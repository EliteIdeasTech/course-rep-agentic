import { COORD_SCALE, type ElementSnapshot, type ModelFunctionCall, type VisionChallengeKind } from './types';
import { isNavigationAllowed } from './domain';
import { classifyAction } from './safety';
import { CHALLENGE_ANSWER_PLACEHOLDER, PASSWORD_PLACEHOLDER } from './types';
import { substitutePassword } from './password';

export type PlannedAction =
  | { kind: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clickCount?: number }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'type'; text: string; pressEnter: boolean; substituted: boolean }
  | { kind: 'scroll'; x: number; y: number; direction: 'up' | 'down' | 'left' | 'right'; pixels: number }
  | { kind: 'navigate'; url: string }
  | { kind: 'go_back' }
  | { kind: 'go_forward' }
  | { kind: 'wait'; ms: number }
  | { kind: 'press_key'; key: string }
  | { kind: 'noop' };

export type ActionPlan =
  | { kind: 'execute'; action: PlannedAction; intent?: string }
  | { kind: 'refuse'; reason: string; intent?: string }
  | { kind: 'pause'; challengeKind: VisionChallengeKind; prompt: string; intent?: string }
  | { kind: 'stop'; status: 'BLOCKED'; reason: string };

export interface DecideContext {
  portalUrl: string;
  currentUrl: string;
  viewport: { width: number; height: number };
  password: string;
  /** Latest student reply, kept only in this process. */
  challengeAnswer?: string;
  allowTyping: boolean;
  passwordVisible: boolean;
  element: ElementSnapshot | null;
}

const SCROLL = new Set(['up', 'down', 'left', 'right']);

export function decideAction(call: ModelFunctionCall, ctx: DecideContext): ActionPlan {
  const name = (call.name || '').trim();
  const args = call.arguments ?? {};
  const intent = typeof args.intent === 'string' ? args.intent : undefined;
  const safetyDecision = readSafetyDecision(args.safety_decision);
  if (safetyDecision === 'blocked') {
    return { kind: 'stop', status: 'BLOCKED', reason: 'model safety system blocked the action' };
  }

  const verdict = classifyAction({
    actionName: name,
    intent: intent ?? '',
    element: ctx.element,
    passwordVisible: ctx.passwordVisible,
    allowTyping: ctx.allowTyping,
  });
  if (!verdict.ok && 'pause' in verdict) {
    return { kind: 'pause', challengeKind: verdict.pause, prompt: verdict.prompt, intent };
  }
  if (!verdict.ok && 'stop' in verdict) {
    return { kind: 'stop', status: 'BLOCKED', reason: verdict.stop };
  }
  if (!verdict.ok && 'reason' in verdict) {
    return { kind: 'refuse', reason: verdict.reason, intent };
  }

  if (name === 'navigate') {
    const url = typeof args.url === 'string' ? args.url : '';
    const domain = isNavigationAllowed(url, ctx.portalUrl, ctx.currentUrl);
    if (!domain.ok || !domain.resolved) {
      return { kind: 'refuse', reason: domain.reason ?? 'navigation refused', intent };
    }
    return { kind: 'execute', action: { kind: 'navigate', url: domain.resolved }, intent };
  }

  if (name === 'click' || name === 'double_click' || name === 'triple_click' || name === 'right_click' || name === 'middle_click') {
    const point = denormalizePoint(args, ctx.viewport);
    if (!point) return { kind: 'refuse', reason: 'click missing coordinates', intent };
    const button = name === 'right_click' ? 'right' : name === 'middle_click' ? 'middle' : 'left';
    const clickCount = name === 'double_click' ? 2 : name === 'triple_click' ? 3 : 1;
    return { kind: 'execute', action: { kind: 'click', ...point, button, clickCount }, intent };
  }

  if (name === 'move' || name === 'mouse_down' || name === 'mouse_up' || name === 'long_press') {
    const point = denormalizePoint(args, ctx.viewport);
    if (!point) return { kind: 'refuse', reason: 'move missing coordinates', intent };
    return { kind: 'execute', action: { kind: 'move', ...point }, intent };
  }

  if (name === 'type') {
    const raw = typeof args.text === 'string' ? args.text : '';
    const substituted = substitutePassword(raw, ctx.password);
    if (!substituted.substituted && ctx.password && raw.includes(ctx.password)) {
      return { kind: 'refuse', reason: 'refused to type a raw password from the model', intent };
    }
    if (raw.includes(PASSWORD_PLACEHOLDER) && !ctx.password) {
      return { kind: 'refuse', reason: 'password placeholder present but no local password', intent };
    }
    const challengeAnswer = ctx.challengeAnswer ?? '';
    let text = substituted.text;
    let didSubstitute = substituted.substituted;
    if (text.includes(CHALLENGE_ANSWER_PLACEHOLDER)) {
      if (!challengeAnswer) {
        return { kind: 'refuse', reason: 'challenge answer is not available yet', intent };
      }
      text = text.split(CHALLENGE_ANSWER_PLACEHOLDER).join(challengeAnswer);
      didSubstitute = true;
    }
    if (challengeAnswer && raw.includes(challengeAnswer)) {
      return { kind: 'refuse', reason: 'refused to type a challenge answer from the model', intent };
    }
    return {
      kind: 'execute',
      action: {
        kind: 'type',
        text,
        pressEnter: args.press_enter === true,
        substituted: didSubstitute,
      },
      intent,
    };
  }

  if (name === 'scroll') {
    const point = denormalizePoint(args, ctx.viewport) ?? { x: 0, y: 0 };
    const direction = typeof args.direction === 'string' && SCROLL.has(args.direction)
      ? (args.direction as 'up' | 'down' | 'left' | 'right')
      : 'down';
    const pixels = clamp(numberArg(args.magnitude_in_pixels, 300), 1, 999);
    return { kind: 'execute', action: { kind: 'scroll', ...point, direction, pixels }, intent };
  }

  if (name === 'wait') {
    const seconds = clamp(numberArg(args.seconds, 1), 0, 5);
    return { kind: 'execute', action: { kind: 'wait', ms: Math.round(seconds * 1000) }, intent };
  }

  if (name === 'go_back') return { kind: 'execute', action: { kind: 'go_back' }, intent };
  if (name === 'go_forward') return { kind: 'execute', action: { kind: 'go_forward' }, intent };
  if (name === 'press_key') {
    const key = typeof args.key === 'string' ? args.key.slice(0, 32) : '';
    if (!key) return { kind: 'refuse', reason: 'press_key missing key', intent };
    if (/delete/i.test(key)) return { kind: 'refuse', reason: 'refused delete action', intent };
    if (/^(enter|return|numpadenter)$/i.test(key) && !(ctx.allowTyping && ctx.passwordVisible)) {
      return { kind: 'refuse', reason: 'refused submit outside login', intent };
    }
    return { kind: 'execute', action: { kind: 'press_key', key }, intent };
  }
  if (name === 'take_screenshot' || name === 'hotkey' || name === 'key_down' || name === 'key_up' || name === 'drag_and_drop') {
    return { kind: 'execute', action: { kind: 'noop' }, intent };
  }

  return { kind: 'refuse', reason: `unhandled action ${name || 'unknown'}`, intent };
}

export function denormalize(value: number, size: number): number {
  const clamped = clamp(value, 0, COORD_SCALE - 1);
  return Math.floor((clamped / COORD_SCALE) * size);
}

function denormalizePoint(
  args: Record<string, unknown>,
  viewport: { width: number; height: number },
): { x: number; y: number } | null {
  if (typeof args.x !== 'number' || typeof args.y !== 'number') return null;
  return {
    x: denormalize(args.x, viewport.width),
    y: denormalize(args.y, viewport.height),
  };
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readSafetyDecision(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'decision' in value) {
    const decision = (value as { decision?: unknown }).decision;
    return typeof decision === 'string' ? decision : undefined;
  }
  return undefined;
}
