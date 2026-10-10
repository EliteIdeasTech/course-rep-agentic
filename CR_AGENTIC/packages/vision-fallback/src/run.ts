import { limitsFromEnv } from './budget';
import { GeminiComputerUseClient } from './gemini';
import { resolveGeminiApiKey, visionFallbackEnabled, visionModelFromEnv } from './flag';
import { runVisionLoop } from './loop';
import { playwrightSurface, type PlaywrightLikePage } from './playwright-surface';
import type { VisionGoal, VisionRunResult, VisionStepLog } from './types';

export async function runPortalVisionFallback(input: {
  env: {
    VISION_FALLBACK_ENABLED?: string | boolean;
    VISION_FALLBACK_MODEL?: string;
    VISION_FALLBACK_MAX_STEPS?: string;
    VISION_FALLBACK_TIMEOUT_MS?: string;
    VISION_FALLBACK_TOKEN_BUDGET?: string;
    GEMINI_API_KEY?: string;
    GOOGLE_API_KEY?: string;
    GOOGLE_GENAI_API_KEY?: string;
    OPENAI_API_KEY?: string;
    OPENAI_BASE_URL?: string;
  };
  metadata: unknown;
  page: PlaywrightLikePage;
  portalUrl: string;
  goal: VisionGoal;
  username?: string;
  password?: string;
  onStep?: (log: VisionStepLog) => void;
}): Promise<VisionRunResult | null> {
  if (!visionFallbackEnabled(input.env, input.metadata)) return null;
  const apiKey = resolveGeminiApiKey(input.env);
  if (!apiKey) {
    return {
      status: 'SKIPPED',
      capture: { profile: {}, courses: [] },
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedUsd: 0,
      latencyMs: 0,
      logs: [],
      stopReason: 'GEMINI_API_KEY is not set',
    };
  }
  const surface = await playwrightSurface(input.page);
  const client = new GeminiComputerUseClient(apiKey, visionModelFromEnv(input.env));
  return runVisionLoop({
    surface,
    client,
    goal: input.goal,
    portalUrl: input.portalUrl,
    username: input.username,
    password: input.password,
    limits: limitsFromEnv(input.env),
    onStep: input.onStep,
  });
}
