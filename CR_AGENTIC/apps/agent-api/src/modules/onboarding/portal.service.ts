import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import Redis from 'ioredis';
import { prisma, LmsType as PrismaLmsType } from '@cr-agentic/database';
import { enqueueJob } from '@cr-agentic/queue';
import { QUEUE_NAMES, PortalCandidateView } from '@cr-agentic/shared';
import type { DiscoveryFindPortalJob } from '@cr-agentic/shared';
import { writeAuditLog } from '@cr-agentic/observability';
import { REDIS_CLIENT } from '../queue/queue.module';
import { OnboardingService } from './onboarding.service';
import {
  ConfirmPortalRequestDto,
  ManualPortalRequestDto,
} from './dto/onboarding.request.dto';
import { sessionIsDemo } from './reviewer-demo';

/** Keep path prefixes like /portalplus/ instead of collapsing to origin-only. */
export function portalBaseFromLoginUrl(loginUrl: string): string {
  const u = new URL(loginUrl);
  let path = u.pathname || '/';
  path = path.replace(/\/login\/?$/i, '/');
  const last = path.split('/').filter(Boolean).pop() ?? '';
  if (last && /\.[a-z0-9]+$/i.test(last)) {
    path = path.replace(/\/[^/]+$/, '/');
  }
  if (!path.endsWith('/')) path += '/';
  if (path === '/') return u.origin;
  return `${u.origin}${path}`;
}

@Injectable()
export class PortalService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly onboarding: OnboardingService,
  ) {}

  async discover(userId: string, sessionId: string) {
    const session = await this.onboarding.requireSession(userId, sessionId);
    if (sessionIsDemo(session.metadata)) {
      throw new BadRequestException('Portal discovery is not used for this session');
    }

    await this.onboarding.transition(sessionId, session.stage, 'PORTAL_DISCOVERING');

    await enqueueJob<DiscoveryFindPortalJob>(
      QUEUE_NAMES.DISCOVERY_FIND_PORTAL,
      this.redis,
      'find-portal',
      {
        onboardingSessionId: sessionId,
        userId,
        universityName: session.universityName,
        country: session.country ?? undefined,
        website: session.website ?? undefined,
      },
    );

    return { stage: 'PORTAL_DISCOVERING' };
  }

  async listCandidates(
    userId: string,
    sessionId: string,
  ): Promise<PortalCandidateView[]> {
    await this.onboarding.requireSession(userId, sessionId);
    const candidates = await prisma.portalCandidate.findMany({
      where: { onboardingSessionId: sessionId },
      orderBy: { confidence: 'desc' },
    });

    return candidates.map((c) => ({
      id: c.id,
      loginUrl: c.loginUrl,
      lmsType: c.lmsType as PortalCandidateView['lmsType'],
      portalName: c.portalName ?? undefined,
      confidence: c.confidence,
      evidence: c.evidence,
      source: c.source as PortalCandidateView['source'],
    }));
  }

  async confirm(userId: string, sessionId: string, dto: ConfirmPortalRequestDto) {
    const session = await this.onboarding.requireSession(userId, sessionId);
    const candidate = await prisma.portalCandidate.findFirst({
      where: { id: dto.candidateId, onboardingSessionId: sessionId },
    });
    if (!candidate) throw new NotFoundException('Portal candidate not found');

    return this.createAccountAndConfirm(
      userId,
      sessionId,
      session.universityId,
      candidate.loginUrl,
      candidate.lmsType,
      candidate.id,
    );
  }

  /** Lets a user supply a portal URL directly when discovery returns nothing usable. */
  async confirmManual(
    userId: string,
    sessionId: string,
    dto: ManualPortalRequestDto,
  ) {
    const session = await this.onboarding.requireSession(userId, sessionId);

    const candidate = await prisma.portalCandidate.create({
      data: {
        onboardingSessionId: sessionId,
        loginUrl: dto.loginUrl,
        portalName: dto.portalName,
        lmsType: dto.lmsType as PrismaLmsType,
        confidence: 1,
        evidence: ['user supplied'],
        source: 'MANUAL',
        selected: true,
      },
    });

    return this.createAccountAndConfirm(
      userId,
      sessionId,
      session.universityId,
      dto.loginUrl,
      dto.lmsType as PrismaLmsType,
      candidate.id,
    );
  }

  private async createAccountAndConfirm(
    userId: string,
    sessionId: string,
    universityId: string | null,
    loginUrl: string,
    lmsType: PrismaLmsType,
    candidateId: string,
  ) {
    const session = await this.onboarding.requireSession(userId, sessionId);
    if (session.stage !== 'PORTAL_SUGGESTED' && session.stage !== 'PORTAL_DISCOVERING') {
      throw new BadRequestException(
        `Cannot confirm portal from stage ${session.stage}`,
      );
    }

    const baseUrl = portalBaseFromLoginUrl(loginUrl);

    const account = await prisma.connectedAccount.create({
      data: {
        userId,
        universityId,
        lmsType,
        lmsBaseUrl: baseUrl,
        status: 'PENDING',
        onboardingSessionId: sessionId,
        portalCandidateId: candidateId,
      },
    });

    await prisma.portalCandidate.update({
      where: { id: candidateId },
      data: { selected: true },
    });

    await this.onboarding.transition(
      sessionId,
      session.stage,
      'PORTAL_CONFIRMED',
      { selectedCandidateId: candidateId },
      { connectedAccountId: account.id, loginUrl },
    );

    await writeAuditLog({
      actorId: userId,
      action: 'portal_confirmed',
      resourceType: 'connected_account',
      resourceId: account.id,
      metadata: { onboardingSessionId: sessionId, loginUrl },
    });

    return { connectedAccountId: account.id, stage: 'PORTAL_CONFIRMED', loginUrl };
  }
}
