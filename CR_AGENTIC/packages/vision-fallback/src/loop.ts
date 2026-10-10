import { budgetBlock, type BudgetState } from './budget';
import { estimateUsd } from './cost';
import { executeAction } from './executor';
import { parseVisionCapture } from './extract';
import { redactSecrets } from './password';
import { buildGoalPrompt } from './prompt';
import {
  emptyCapture,
  type ComputerSurface,
  type ComputerUseClient,
  type FunctionResultInput,
  type VisionCapture,
  type VisionGoal,
  type VisionLimits,
  type VisionRunResult,
  type VisionStatus,
  type VisionStepLog,
} from './types';

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
}

export async function runVisionLoop(input: VisionLoopInput): Promise<VisionRunResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const state: BudgetState = { steps: 0, inputTokens: 0, outputTokens: 0, startedAt };
  const logs: VisionStepLog[] = [];
  const screenshots: string[] = [];
  const password = input.password ?? '';
  const allowTyping = input.goal === 'login_and_extract';
  const goalPrompt = buildGoalPrompt(input.goal, input.portalUrl, input.username);
  let previousInteractionId: string | undefined;
  let functionResults: FunctionResultInput[] | undefined;
  let status: VisionStatus = 'FAILED';
  let stopReason: string | undefined;
  let capture = emptyCapture();

  const finish = async (next: VisionStatus, reason?: string, runExtract = false): Promise<VisionRunResult> => {
    status = next;
    stopReason = reason;
    if (runExtract && next !== 'CAPTCHA_REQUIRED' && next !== 'OTP_REQUIRED' && next !== 'BLOCKED') {
      const extracted = await extractBestEffort(input, screenshots, password);
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
      estimatedUsd: estimateUsd(state.inputTokens, state.outputTokens),
      latencyMs: Math.max(0, now() - startedAt),
      logs,
      stopReason,
    };
  };

  try {
    for (;;) {
      const blocked = budgetBlock(state, input.limits, now());
      if (blocked) return finish(blocked, blocked, blocked !== 'TIMEOUT');

      const challenge = await input.surface.challengeVisible();
      if (challenge === 'captcha') return finish('CAPTCHA_REQUIRED', 'CAPTCHA_REQUIRED');
      if (challenge === 'otp') return finish('OTP_REQUIRED', 'OTP_REQUIRED');
      if (input.goal === 'find_login_form' && (await input.surface.loginFormVisible())) {
        return finish('LOGIN_FORM_FOUND', 'LOGIN_FORM_FOUND');
      }

      const shot = await input.surface.screenshot();
      const screenshotPngBase64 = shot.toString('base64');
      screenshots.push(screenshotPngBase64);
      if (screenshots.length > 4) screenshots.shift();
      const htmlExcerpt = redactSecrets(await input.surface.htmlExcerpt(12_000), [password]);

      const turn = await input.client.nextAction({
        goalPrompt,
        screenshotPngBase64,
        previousInteractionId,
        functionResults,
        htmlExcerpt,
      });
      state.inputTokens += turn.inputTokens;
      state.outputTokens += turn.outputTokens;
      previousInteractionId = turn.id ?? previousInteractionId;
      if (state.inputTokens + state.outputTokens >= input.limits.tokenBudget) {
        return finish('BUDGET_EXCEEDED', 'token budget', true);
      }

      const text = turn.text || '';
      if (/CAPTCHA_REQUIRED/i.test(text)) return finish('CAPTCHA_REQUIRED', 'CAPTCHA_REQUIRED');
      if (/OTP_REQUIRED/i.test(text)) return finish('OTP_REQUIRED', 'OTP_REQUIRED');
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
          allowTyping,
          passwordVisible: await input.surface.passwordFieldVisible(),
        });
        const refused = executed.plan.kind === 'refuse'
          ? executed.plan.reason
          : executed.plan.kind === 'stop'
            ? executed.plan.reason
            : executed.error;
        const log: VisionStepLog = {
          step: state.steps,
          action: call.name,
          intent: redactSecrets(executed.plan.kind === 'execute' ? executed.plan.intent ?? '' : executed.plan.kind === 'refuse' ? executed.plan.intent ?? '' : '', [password]),
          url: input.surface.url(),
          refused: refused ? redactSecrets(refused, [password]) : undefined,
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
        if (screenshots.length > 4) screenshots.shift();
        results.push({
          name: call.name,
          callId: call.id,
          url: input.surface.url(),
          error: refused ? redactSecrets(refused, [password]) : undefined,
          screenshotPngBase64: afterShot,
        });
      }
      functionResults = results;
    }
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err), [password]);
    return finish('FAILED', message);
  }
}

async function extractBestEffort(
  input: VisionLoopInput,
  screenshots: string[],
  password: string,
): Promise<{ capture: VisionCapture; inputTokens: number; outputTokens: number }> {
  if (input.goal === 'find_login_form' || screenshots.length === 0) {
    return { capture: emptyCapture(), inputTokens: 0, outputTokens: 0 };
  }
  try {
    const htmlExcerpt = redactSecrets(await input.surface.htmlExcerpt(12_000), [password]);
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

function hasCapture(capture: VisionCapture): boolean {
  const profile = Object.values(capture.profile).some((value) => !!value);
  return profile || capture.courses.length > 0 || !!capture.results;
}
