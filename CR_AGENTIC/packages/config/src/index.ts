import { z } from 'zod';

const emptyToUndefined = (v: unknown) =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

export const agentEnvSchema = z.object({
  AGENT_API_PORT: z.coerce.number().default(3100),
  JWT_SECRET: z.string().min(1),
  JWT_ISSUER: z.string().default('course-rep'),
  JWT_AUDIENCE: z.string().default('course-rep-users'),
  AGENT_DATABASE_URL: z.string().url().or(z.string().startsWith('postgresql://')),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  COURSE_REP_API_URL: z.string().url().default('http://localhost:3000'),
  INTERNAL_API_SECRET: z.string().min(8),
  AWS_REGION: z.string().default('us-east-1'),
  AWS_S3_BUCKET: z.string().min(1),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  // Optional S3-compatible endpoint (e.g. self-hosted MinIO).
  // Leave unset to use real AWS S3.
  AWS_ENDPOINT_URL: z.string().url().optional(),
  SESSION_ENCRYPTION_KEY: z.string().min(32),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o'),
  // Optional override for OpenAI-compatible providers (e.g. OpenRouter:
  // https://openrouter.ai/api/v1, Gemini:
  // https://generativelanguage.googleapis.com/v1beta/openai/).
  // Leave unset to use OpenAI directly.
  OPENAI_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  // Stronger model for multi-step portal navigation decisions. Falls back to
  // OPENAI_MODEL when unset.
  OPENAI_NAV_MODEL: z.preprocess(emptyToUndefined, z.string().optional()),
  PORTAL_SEARCH_API_KEY: z.string().optional(),
  // App Review password for universities with isDemo=true. Username is
  // `appreview`. Unset or blank rejects every demo credential attempt.
  REVIEWER_PORTAL_PASSWORD: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional(),
  ),
  // Gemini key used by the vision fallback. When unset, a Gemini
  // OPENAI_BASE_URL plus OPENAI_API_KEY is used instead.
  GEMINI_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  GOOGLE_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  // Off unless exactly true/1. A session may override via metadata.visionFallbackEnabled.
  VISION_FALLBACK_ENABLED: z.preprocess(
    (value) => value === true || value === 'true' || value === '1',
    z.boolean().default(false),
  ),
  VISION_FALLBACK_MODEL: z.preprocess(
    emptyToUndefined,
    z.string().min(1).default('gemini-3.8-flash'),
  ),
  VISION_FALLBACK_MAX_STEPS: z.coerce.number().default(25),
  VISION_FALLBACK_TIMEOUT_MS: z.coerce.number().default(180_000),
  VISION_FALLBACK_TOKEN_BUDGET: z.coerce.number().default(200_000),
  VISION_CHALLENGE_TIMEOUT_MS: z.coerce.number().default(180_000),
  PORTAL_SEARCH_ENDPOINT: z.string().default('https://google.serper.dev/search'),
  BROWSER_MAX_CONTEXTS: z.coerce.number().default(50),
  BROWSER_HEADLESS: z
    .string()
    .transform((v) => v !== 'false')
    .default('true'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  SENTRY_DSN: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
});

export type AgentEnv = z.infer<typeof agentEnvSchema>;

export function loadAgentEnv(
  env: NodeJS.ProcessEnv = process.env,
): AgentEnv {
  return agentEnvSchema.parse(env);
}

export const REDIS_KEY_PREFIX = 'cr:agent:';
