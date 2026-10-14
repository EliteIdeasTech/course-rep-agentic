import { DEFAULT_MAX_STEPS, DEFAULT_TIMEOUT_MS, DEFAULT_TOKEN_BUDGET, type VisionLimits } from './types';

export interface BudgetState {
  steps: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: number;
}

export function limitsFromEnv(env: {
  VISION_FALLBACK_MAX_STEPS?: string;
  VISION_FALLBACK_TIMEOUT_MS?: string;
  VISION_FALLBACK_TOKEN_BUDGET?: string;
}): VisionLimits {
  return {
    maxSteps: positiveInt(env.VISION_FALLBACK_MAX_STEPS, DEFAULT_MAX_STEPS),
    timeoutMs: positiveInt(env.VISION_FALLBACK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    tokenBudget: positiveInt(env.VISION_FALLBACK_TOKEN_BUDGET, DEFAULT_TOKEN_BUDGET),
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export function budgetBlock(
  state: BudgetState,
  limits: VisionLimits,
  now: number,
): 'TIMEOUT' | 'BUDGET_EXCEEDED' | null {
  if (now - state.startedAt >= limits.timeoutMs) return 'TIMEOUT';
  if (state.steps >= limits.maxSteps) return 'BUDGET_EXCEEDED';
  if (state.inputTokens + state.outputTokens >= limits.tokenBudget) return 'BUDGET_EXCEEDED';
  return null;
}
