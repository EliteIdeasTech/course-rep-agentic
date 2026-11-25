import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { timingSafeEqual } from 'crypto';
import { prisma } from '@cr-agentic/database';
import {
  aggregateFunnel,
  funnelReasonForLoginReason,
  funnelStepForStage,
  isTestSchoolName,
  type FunnelSessionRow,
} from '@cr-agentic/shared';
import { Public } from '../auth/public.decorator';

const STAGE_RANK: Record<string, number> = {
  UNIVERSITY_SELECTED: 0,
  PORTAL_DISCOVERING: 1,
  PORTAL_SUGGESTED: 2,
  PORTAL_CONFIRMED: 3,
  AWAITING_LOGIN: 4,
  LOGIN_IN_PROGRESS: 5,
  SESSION_CAPTURED: 6,
  DEEP_DISCOVERY: 7,
  ONBOARDING_COMPLETE: 8,
};
const RANK_STAGE = Object.fromEntries(Object.entries(STAGE_RANK).map(([k, v]) => [v, k]));

/** YYYY-MM-DD in Africa/Lagos (UTC+1, no DST). */
export function watDay(d: Date): string {
  return new Date(d.getTime() + 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function secretMatches(given: string | undefined, expected: string): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Ops-only per-school, per-day portal-connect funnel. Authenticated with the
 * shared INTERNAL_API_SECRET (x-internal-secret header), same secret the main
 * API already uses to talk to the agent; CRadmin / backend can proxy it.
 * Returns counts and reason codes only: no user ids, names or credentials.
 */
@ApiTags('admin')
@Controller('admin/portal-funnel')
export class PortalFunnelAdminController {
  constructor(private readonly config: ConfigService) {}

  @Public()
  @Get()
  @ApiHeader({ name: 'x-internal-secret', required: true })
  async funnel(
    @Headers('x-internal-secret') secret: string | undefined,
    @Query('from') fromQ?: string,
    @Query('to') toQ?: string,
    @Query('school') school?: string,
    @Query('groupBy') groupBy?: string,
    @Query('includeTest') includeTest?: string,
  ) {
    if (!secretMatches(secret, this.config.get<string>('INTERNAL_API_SECRET', ''))) {
      throw new UnauthorizedException();
    }
    const to = toQ ? new Date(`${toQ}T23:59:59.999+01:00`) : new Date();
    const from = fromQ
      ? new Date(`${fromQ}T00:00:00+01:00`)
      : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      throw new BadRequestException('from/to must be YYYY-MM-DD and from <= to');
    }

    const sessions = await prisma.onboardingSession.findMany({
      where: {
        createdAt: { gte: from, lte: to },
        ...(school ? { universityName: { contains: school, mode: 'insensitive' as const } } : {}),
      },
      select: {
        id: true,
        universityName: true,
        stage: true,
        metadata: true,
        createdAt: true,
        auditEvents: { select: { toStage: true, detail: true } },
        funnelEvents: { select: { event: true, step: true, reason: true } },
      },
    });

    const rows: FunnelSessionRow[] = [];
    for (const s of sessions) {
      const demo = !!(s.metadata as { demo?: unknown } | null)?.demo;
      if (includeTest !== 'true' && (demo || isTestSchoolName(s.universityName))) continue;
      let rank = -1;
      const reasons: string[] = [];
      for (const a of s.auditEvents) {
        rank = Math.max(rank, STAGE_RANK[a.toStage] ?? -1);
        if (a.toStage === 'REAUTH_REQUIRED' || a.toStage === 'FAILED') {
          const d = (a.detail ?? {}) as { reason?: unknown; message?: unknown };
          reasons.push(funnelReasonForLoginReason(d.reason, typeof d.message === 'string' ? d.message : undefined));
        }
      }
      let cancelledAtStep: string | null | undefined;
      for (const f of s.funnelEvents) {
        if (f.event === 'failed' && f.reason) reasons.push(f.reason);
        if (f.event === 'cancelled') cancelledAtStep = f.step ?? 'unknown';
      }
      if (s.stage === 'CANCELLED' && cancelledAtStep === undefined) {
        // Pre-funnel sessions: the furthest stage before cancel is the best we have.
        cancelledAtStep = funnelStepForStage(RANK_STAGE[rank]) ?? 'unknown';
      }
      if (s.stage === 'CANCELLED') reasons.push('user_cancelled');
      rows.push({
        sessionId: s.id,
        school: s.universityName,
        day: watDay(s.createdAt),
        furthestStep: funnelStepForStage(RANK_STAGE[rank]),
        completed: s.stage === 'ONBOARDING_COMPLETE',
        reasons,
        cancelledAtStep: s.stage === 'CANCELLED' ? cancelledAtStep : undefined,
      });
    }

    const byDay = groupBy !== 'school';
    return {
      from: watDay(from),
      to: watDay(to),
      timezone: 'Africa/Lagos',
      excludesTest: includeTest !== 'true',
      totals: aggregateFunnel(
        rows.map((r) => ({ ...r, school: 'ALL' })),
        { byDay: false },
      )[0] ?? null,
      rows: aggregateFunnel(rows, { byDay }),
    };
  }
}
