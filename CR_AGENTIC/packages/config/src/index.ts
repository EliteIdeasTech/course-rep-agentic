import { z } from 'zod';

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
  // https://openrouter.ai/api/v1). Leave unset to use OpenAI directly.
  OPENAI_BASE_URL: z.string().url().optional(),
  PORTAL_SEARCH_API_KEY: z.string().optional(),
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
