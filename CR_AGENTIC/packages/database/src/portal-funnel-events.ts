import {
  classifyFunnelError,
  funnelReasonForLoginReason,
  funnelStepForStage,
  sanitizeFunnelMessage,
  sanitizeFunnelMetadata,
  type FunnelEventKind,
} from '@cr-agentic/shared';
import { Prisma } from '@prisma/client';
import { prisma } from './index';

export interface FunnelEventInput {
  sessionId: string;
  event: FunnelEventKind;
  step?: string | null;
  fromStep?: string | null;
  reason?: string | null;
  rawReason?: string | null;
  errorClass?: string | null;
  httpStatus?: number | null;
  message?: string | null;
  source: 'server' | 'browser_worker' | 'discovery_worker' | 'mobile' | 'web';
  platform?: string | null;
  appVersion?: string | null;
  metadata?: Record<string, unknown> | null;
}

const short = (v: unknown, n: number) =>
  typeof v === 'string' && v ? v.slice(0, n) : null;

/**
 * Writes one funnel row. Never throws: funnel logging must not break onboarding.
 * Message and metadata are sanitised here even if the caller already did.
 */
export async function recordFunnelEvent(input: FunnelEventInput): Promise<void> {
  try {
    const metadata = sanitizeFunnelMetadata(input.metadata ?? undefined);
    await prisma.onboardingFunnelEvent.create({
      data: {
        onboardingSessionId: input.sessionId,
        event: input.event,
        step: short(input.step, 40),
        fromStep: short(input.fromStep, 40),
        reason: short(input.reason, 40),
        rawReason: short(input.rawReason, 60),
        errorClass: short(input.errorClass, 80),
        httpStatus: typeof input.httpStatus === 'number' ? input.httpStatus : null,
        message: sanitizeFunnelMessage(input.message ?? '') || null,
        source: input.source,
        platform: short(input.platform, 20),
        appVersion: short(input.appVersion, 30),
        metadata: metadata as Prisma.InputJsonValue | undefined,
      },
    });
  } catch {
    // swallow: observability only
  }
}

const FAILURE_STAGES = new Set(['REAUTH_REQUIRED', 'FAILED']);

/**
 * Funnel row for a stage transition. Failure stages (REAUTH_REQUIRED / FAILED)
 * become `failed` events with the structured reason mapped from detail.reason;
 * CANCELLED becomes `cancelled` at the step the session was on.
 */
export function funnelEventForTransition(
  sessionId: string,
  from: string | null,
  to: string,
  detail: Record<string, unknown> | undefined,
  source: FunnelEventInput['source'],
): FunnelEventInput {
  const fromStep = funnelStepForStage(from);
  if (to === 'CANCELLED') {
    return {
      sessionId,
      event: 'cancelled',
      step: (detail?.step as string | undefined) ?? fromStep,
      fromStep,
      reason: 'user_cancelled',
      rawReason: typeof detail?.clientReason === 'string' ? detail.clientReason : null,
      source,
    };
  }
  if (FAILURE_STAGES.has(to)) {
    const raw = typeof detail?.reason === 'string' ? detail.reason : null;
    const msg = typeof detail?.message === 'string' ? detail.message : undefined;
    const classified = msg ? classifyFunnelError({ message: msg }) : undefined;
    return {
      sessionId,
      event: 'failed',
      step: fromStep,
      fromStep,
      reason: funnelReasonForLoginReason(raw, msg),
      rawReason: raw,
      errorClass:
        typeof detail?.errorClass === 'string'
          ? detail.errorClass
          : raw === 'credential_login_error'
            ? (classified?.errorClass ?? null)
            : null,
      message: classified?.message ?? null,
      source,
      metadata: typeof detail?.portalHost === 'string' ? { portalHost: detail.portalHost } : null,
    };
  }
  return { sessionId, event: 'step', step: funnelStepForStage(to), fromStep, source };
}
