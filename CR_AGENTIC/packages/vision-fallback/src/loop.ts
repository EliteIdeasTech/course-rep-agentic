import { budgetBlock, type BudgetState } from './budget';
import { challengeFromModelText, createChallenge } from './challenge';
import { estimateUsd } from './cost';
import { executeAction } from './executor';
import { parseVisionCapture } from './extract';
import { redactSecrets } from './password';
import { buildGoalPrompt } from './prompt';
import {
  DEFAULT_CHALLENGE_TIMEOUT_MS,
  emptyCapture,
  type ChallengeWaitResult,
  type ComputerSurface,
  type ComputerUseClient,
  type FunctionResultInput,
  type VisionCapture,
  type VisionChallenge,
  type VisionChallengeKind,
  type VisionGoal,
  type VisionLimits,
  type VisionRunResult,
  type VisionStatus,
  type VisionStepLog,
} from './types';

/** Each follow-up re-bills every prior image, so the chain is restarted after this many. */
const MAX_SCREENSHOTS = 3;

export interface VisionLoopInput {
  surface: ComputerSurface;
  client: ComputerUseClient;
  goal: VisionGoal;
  portalUrl: string;
  username?: string;
  password?: string;
  limits: VisionLimits;
  now?: () => number;
  onStep?: (log: VisionStepLog) => void;
  challengeTimeoutMs?: number;
  /**
   * Pauses the browser until the student answers. When omitted, the run
   * returns AWAITING_USER_INPUT with the challenge payload.
   */
  awaitUserInput?: (challenge: VisionChallenge) => Promise<ChallengeWaitResult>;
  /** Model id used to price the run. Defaults to flash-lite rates when omitted. */
  model?: string;
}

export async function runVisionLoop(input: VisionLoopInput): Promise<VisionRunResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const state: BudgetState = { steps: 0, inputTokens: 0, outputTokens: 0, startedAt };
  const logs: VisionStepLog[] = [];
  const screenshots: string[] = [];
  const password = input.password ?? '';
  const secrets: string[] = [password];
  let challengeAnswer = '';
  let suppressPagePause = false;
  const challengeTimeoutMs = input.challengeTimeoutMs ?? DEFAULT_CHALLENGE_TIMEOUT_MS;
  const allowTyping = input.goal === 'login_and_extract';
  const goalPrompt = buildGoalPrompt(input.goal, input.portalUrl, input.username);
  let previousInteractionId: string | undefined;
  let functionResults: FunctionResultInput[] | undefined;
  let imagesOnInteraction = 0;
  let status: VisionStatus = 'FAILED';
  let stopReason: string | undefined;
  let capture = emptyCapture();

  const finish = async (
    next: VisionStatus,
    reason?: string,
    runExtract = false,
    challenge?: VisionChallenge,
  ): Promise<VisionRunResult> => {
    status = next;
    stopReason = reason;
    if (runExtract && next !== 'CAPTCHA_REQUIRED' && next !== 'OTP_REQUIRED' && next !== 'BLOCKED') {
      const extracted = await extractBestEffort(input, screenshots, secrets);
      capture = extracted.capture;
      state.inputTokens += extracted.inputTokens;
      state.outputTokens += extracted.outputTokens;
      if (hasCapture(capture) && (next === 'SIGNED_IN' || next === 'FAILED' || input.goal === 'extract')) {
        status = 'CAPTURED';
      }
    }
    return {
      status,
      capture,
      steps: state.steps,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      estimatedUsd: estimateUsd(state.inputTokens, state.outputTokens, input.model),
      latencyMs: Math.max(0, now() - startedAt),
      logs,
      stopReason,
      ...(challenge ? { challenge } : {}),
    };
  };

  const handoff = async (detected: { kind: VisionChallengeKind; prompt: string }): Promise<'continue' | VisionRunResult> => {
    const cropped = await input.surface.cropChallenge?.();
    const challenge = createChallenge({
      kind: detected.kind,
      prompt: detected.prompt,
      imagePngBase64: cropped?.toString('base64'),
      now: now(),
      timeoutMs: challengeTimeoutMs,
    });
    if (!input.awaitUserInput) {
      return finish('AWAITING_USER_INPUT', 'AWAITING_USER_INPUT', false, challenge);
    }
    const before = now();
    const waited = await input.awaitUserInput(challenge);
    state.startedAt += Math.max(0, now() - before);
    if (waited.status === 'timeout') return finish('CHALLENGE_TIMEOUT', 'CHALLENGE_TIMEOUT');
    if (waited.status === 'session_expired') return finish('SESSION_EXPIRED', 'SESSION_EXPIRED');
    secrets.push(waited.answer);
    challengeAnswer = waited.answer;
    input.surface.noteSecret?.(waited.answer);
    await input.surface.focusChallenge?.(detected.kind);
    await input.surface.typeText(waited.answer, false);
    suppressPagePause = true;
    return 'continue';
  };

  try {
    for (;;) {
      const blocked = budgetBlock(state, input.limits, now());
      if (blocked) return finish(blocked, blocked, blocked !== 'TIMEOUT');

      const challenge = await input.surface.challengeVisible();
      if (challenge && !suppressPagePause) {
        const handed = await handoff(challenge);
        if (handed !== 'continue') return handed;
        continue;
      }
      suppressPagePause = false;
      if (input.goal === 'find_login_form' && (await input.surface.loginFormVisible())) {
        return finish('LOGIN_FORM_FOUND', 'LOGIN_FORM_FOUND');
      }

      const shot = await input.surface.screenshot();
      const screenshotPngBase64 = shot.toString('base64');
      screenshots.push(screenshotPngBase64);
      trimScreenshots(screenshots);
      const htmlExcerpt = redactSecrets(await input.surface.htmlExcerpt(4_000), secrets);

      let continuePrevious = Boolean(previousInteractionId && functionResults && functionResults.length > 0);
      if (continuePrevious && imagesOnInteraction >= MAX_SCREENSHOTS) {
        previousInteractionId = undefined;
        functionResults = undefined;
        continuePrevious = false;
      }

      const turn = await input.client.nextAction({
        goalPrompt,
        screenshotPngBase64,
        historyScreenshots: continuePrevious ? undefined : screenshots.slice(-MAX_SCREENSHOTS),
        previousInteractionId: continuePrevious ? previousInteractionId : undefined,
        functionResults: continuePrevious ? functionResults : undefined,
        htmlExcerpt,
      });
      state.inputTokens += turn.inputTokens;
      state.outputTokens += turn.outputTokens;
      imagesOnInteraction = continuePrevious
        ? imagesOnInteraction + (functionResults?.length ?? 0)
        : screenshots.length;
      previousInteractionId = turn.id ?? (continuePrevious ? previousInteractionId : undefined);
      if (state.inputTokens + state.outputTokens >= input.limits.tokenBudget) {
        return finish('BUDGET_EXCEEDED', 'token budget', true);
      }

      const text = turn.text || '';
      const modelChallenge = challengeFromModelText(text);
      if (modelChallenge) {
        const handed = await handoff(modelChallenge);
        if (handed !== 'continue') return handed;
        continue;
      }
      if (input.goal === 'find_login_form' && /LOGIN_FORM_FOUND/i.test(text)) {
        return finish('LOGIN_FORM_FOUND', 'LOGIN_FORM_FOUND');
      }
      if (turn.calls.length === 0) {
        const signedIn = input.goal !== 'find_login_form' && !(await input.surface.passwordFieldVisible());
        return finish(signedIn || input.goal === 'extract' ? 'SIGNED_IN' : 'FAILED', 'model stopped', true);
      }

      const results: FunctionResultInput[] = [];
      for (const call of turn.calls) {
        const stepBlocked = budgetBlock(state, input.limits, now());
        if (stepBlocked) return finish(stepBlocked, stepBlocked, true);
        state.steps += 1;
        const executed = await executeAction(call, input.surface, {
          portalUrl: input.portalUrl,
          password,
          challengeAnswer,
          allowTyping,
          passwordVisible: await input.surface.passwordFieldVisible(),
        });
        if (executed.plan.kind === 'pause') {
          const handed = await handoff({ kind: executed.plan.challengeKind, prompt: executed.plan.prompt });
          if (handed !== 'continue') return handed;
        }
        const refused = executed.plan.kind === 'refuse'
          ? executed.plan.reason
          : executed.plan.kind === 'stop'
            ? executed.plan.reason
            : executed.plan.kind === 'pause'
              ? undefined
              : executed.error;
        const log: VisionStepLog = {
          step: state.steps,
          action: call.name,
          intent: redactSecrets(executed.plan.kind === 'execute' || executed.plan.kind === 'refuse' || executed.plan.kind === 'pause' ? executed.plan.intent ?? '' : '', secrets),
          url: input.surface.url(),
          refused: refused ? redactSecrets(refused, secrets) : undefined,
          inputTokens: state.inputTokens,
          outputTokens: state.outputTokens,
        };
        logs.push(log);
        input.onStep?.(log);
        if (executed.plan.kind === 'stop') {
          return finish(executed.plan.status, executed.plan.reason);
        }
        const afterShot = (await input.surface.screenshot()).toString('base64');
        screenshots.push(afterShot);
        trimScreenshots(screenshots);
        results.push({
          name: call.name,
          callId: call.id,
          url: input.surface.url(),
          error: executed.plan.kind === 'pause'
            ? 'paused for the student'
            : refused ? redactSecrets(refused, secrets) : undefined,
          screenshotPngBase64: afterShot,
        });
      }
      functionResults = results;
    }
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err), secrets);
    return finish('FAILED', message);
  }
}

async function extractBestEffort(
  input: VisionLoopInput,
  screenshots: string[],
  secrets: string[],
): Promise<{ capture: VisionCapture; inputTokens: number; outputTokens: number }> {
  if (input.goal === 'find_login_form' || screenshots.length === 0) {
    return { capture: emptyCapture(), inputTokens: 0, outputTokens: 0 };
  }
  try {
    const htmlExcerpt = redactSecrets(await input.surface.htmlExcerpt(12_000), secrets);
    const extracted = await input.client.extract({
      screenshots: screenshots.slice(-3),
      htmlExcerpt,
    });
    return {
      capture: parseVisionCapture(extracted.capture),
      inputTokens: extracted.inputTokens,
      outputTokens: extracted.outputTokens,
    };
  } catch {
    return { capture: emptyCapture(), inputTokens: 0, outputTokens: 0 };
  }
}

function trimScreenshots(screenshots: string[]): void {
  while (screenshots.length > MAX_SCREENSHOTS) screenshots.shift();
}

function hasCapture(capture: VisionCapture): boolean {
  const profile = Object.values(capture.profile).some((value) => !!value);
  return profile || capture.courses.length > 0 || !!capture.results;
}
