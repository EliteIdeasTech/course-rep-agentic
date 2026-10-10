export {
  COMPUTER_USE_MODEL,
  COORD_SCALE,
  DEFAULT_MAX_STEPS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOKEN_BUDGET,
  DEFAULT_VIEWPORT,
  GEMINI_35_FLASH_LITE_USD_PER_MILLION,
  GEMINI_38_FLASH_USD_PER_MILLION,
  CHALLENGE_ANSWER_PLACEHOLDER,
  DEFAULT_CHALLENGE_TIMEOUT_MS,
  PASSWORD_PLACEHOLDER,
  emptyCapture,
} from './types';
export type {
  ComputerSurface,
  ComputerUseClient,
  ElementSnapshot,
  FunctionResultInput,
  ModelFunctionCall,
  ModelTurn,
  ChallengeWaitResult,
  VisionCapture,
  VisionChallenge,
  VisionChallengeKind,
  VisionCourse,
  VisionGoal,
  VisionLimits,
  VisionProfile,
  VisionResults,
  VisionRunResult,
  VisionStatus,
  VisionStepLog,
} from './types';
export { substitutePassword, redactSecrets, assertNoPassword } from './password';
export { registrableDomain, isNavigationAllowed } from './domain';
export { classifyAction, pageChallenge } from './safety';
export {
  challengeFromModelText,
  challengeTimeoutFromEnv,
  createChallenge,
  publishAndWaitForChallenge,
  readPendingChallenge,
  submitChallengeAnswer,
  visionChallengeAnswerKey,
  visionChallengeKey,
} from './challenge';
export type { ChallengeRedis, ChallengeSubmitResult } from './challenge';
export { budgetBlock, limitsFromEnv } from './budget';
export { estimateUsd, estimateNgn } from './cost';
export { visionFallbackEnabled, resolveGeminiApiKey, visionModelFromEnv } from './flag';
export { decideAction, denormalize } from './decide';
export { executeAction } from './executor';
export { runVisionLoop } from './loop';
export { runPortalVisionFallback } from './run';
export { buildGoalPrompt } from './prompt';
export { parseVisionCapture } from './extract';
export { GeminiComputerUseClient, buildComputerUseRequest, parseModelTurn, readUsage } from './gemini';
export { playwrightSurface } from './playwright-surface';
export type { PlaywrightLikePage } from './playwright-surface';
export { saveVisionCapture } from './persist';
export type { VisionCaptureStore } from './persist';
