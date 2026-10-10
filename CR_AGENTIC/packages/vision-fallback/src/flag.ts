/**
 * Env flag defaults off. Session metadata `visionFallbackEnabled` overrides it
 * for a single onboarding session. Demo sessions never enable it: they have no
 * portal and must not send the review password to a model.
 */
export function visionFallbackEnabled(
  env: { VISION_FALLBACK_ENABLED?: string | boolean },
  metadata: unknown,
): boolean {
  if (isDemoMetadata(metadata)) return false;
  const override = readOverride(metadata);
  if (override !== undefined) return override;
  const raw = env.VISION_FALLBACK_ENABLED;
  return raw === true || raw === 'true' || raw === '1';
}

export function resolveGeminiApiKey(env: {
  GEMINI_API_KEY?: string;
  GOOGLE_API_KEY?: string;
  GOOGLE_GENAI_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
}): string | undefined {
  for (const candidate of [env.GEMINI_API_KEY, env.GOOGLE_API_KEY, env.GOOGLE_GENAI_API_KEY]) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  const base = env.OPENAI_BASE_URL ?? '';
  const openai = env.OPENAI_API_KEY?.trim();
  if (openai && /generativelanguage\.googleapis\.com/i.test(base)) return openai;
  return undefined;
}

export function visionModelFromEnv(env: { VISION_FALLBACK_MODEL?: string }): string {
  const model = env.VISION_FALLBACK_MODEL?.trim();
  return model || 'gemini-3.8-flash';
}

function isDemoMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  return (metadata as Record<string, unknown>).isDemo === true;
}

function readOverride(metadata: unknown): boolean | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>).visionFallbackEnabled;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return undefined;
}
