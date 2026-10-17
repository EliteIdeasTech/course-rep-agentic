import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import Redis from 'ioredis';
import { prisma, LmsType as PrismaLmsType } from '@cr-agentic/database';
import { enqueueJob } from '@cr-agentic/queue';
import {
  QUEUE_NAMES,
  PortalCandidateView,
  normalizePortalUrl,
  portalMatchKey,
} from '@cr-agentic/shared';
import type { DiscoveryFindPortalJob } from '@cr-agentic/shared';
import { writeAuditLog } from '@cr-agentic/observability';
import { REDIS_CLIENT } from '../queue/queue.module';
import { OnboardingService } from './onboarding.service';
import {
  ConfirmPortalRequestDto,
  ManualPortalRequestDto,
} from './dto/onboarding.request.dto';
import { sessionIsDemo } from './reviewer-demo';

const REACH_TIMEOUT_MS = 6_000;

/** Keep path prefixes like /portalplus/ instead of collapsing to origin-only. */
export function portalBaseFromLoginUrl(loginUrl: string): string {
  const u = new URL(normalizePortalUrl(loginUrl) ?? loginUrl);
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

    // The app can call this twice (screen bootstrap + start flow). A second
    // job used to replace every candidate with new ids while the app still
    // held the old ones, so the student's pick failed with "Portal candidate
    // not found". One discovery run per session is enough.
    if (session.stage === 'PORTAL_DISCOVERING') {
      return { stage: 'PORTAL_DISCOVERING' };
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
    if (!candidate) {
      // The app can hold a candidate id from an earlier session for the same
      // school (e.g. after a restart). Reuse that candidate's URL here.
      const other = await prisma.portalCandidate.findUnique({
        where: { id: dto.candidateId },
        include: { onboardingSession: { select: { universityName: true } } },
      });
      if (
        !other ||
        other.onboardingSession?.universityName?.trim().toLowerCase() !==
          session.universityName?.trim().toLowerCase()
      ) {
        // Stale id (e.g. candidates refreshed by a second discovery run). If
        // the client also sent the URL it was showing, use that instead.
        if (dto.loginUrl) {
          return this.confirmManual(userId, sessionId, {
            loginUrl: dto.loginUrl,
            lmsType: 'GENERIC',
          } as ManualPortalRequestDto);
        }
        throw new NotFoundException(
          'That portal option has expired. Pick it again or type the portal address.',
        );
      }
      return this.confirmManual(userId, sessionId, {
        loginUrl: other.loginUrl,
        lmsType: other.lmsType,
        portalName: other.portalName ?? undefined,
      } as ManualPortalRequestDto);
    }

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
    this.assertCanConfirm(session.stage);

    const normalized = normalizePortalUrl(dto.loginUrl);
    if (!normalized) {
      throw new BadRequestException(
        'That does not look like a web address. Try something like portal.yourschool.edu',
      );
    }

    // Typed URL that points at a portal we already suggested: confirm that
    // candidate (keeps its LMS type and name) instead of adding a duplicate.
    const key = portalMatchKey(normalized);
    const existing = await prisma.portalCandidate.findMany({
      where: { onboardingSessionId: sessionId },
      orderBy: { confidence: 'desc' },
    });
    const match = existing.find((c) => portalMatchKey(c.loginUrl) === key);
    if (match) {
      return this.createAccountAndConfirm(
        userId,
        sessionId,
        session.universityId,
        match.loginUrl,
        match.lmsType,
        match.id,
      );
    }

    const loginUrl = await this.preferReachableScheme(normalized);
    const candidate = await prisma.portalCandidate.create({
      data: {
        onboardingSessionId: sessionId,
        loginUrl,
        portalName: dto.portalName,
        lmsType: (dto.lmsType ?? 'GENERIC') as PrismaLmsType,
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
      loginUrl,
      (dto.lmsType ?? 'GENERIC') as PrismaLmsType,
      candidate.id,
    );
  }

  /**
   * https first. If it does not answer from our server but plain http does,
   * use http. If neither answers (some portals block our server), keep https
   * and let the login step report it.
   */
  private async preferReachableScheme(url: string): Promise<string> {
    if (!url.startsWith('https://')) {
      if (await this.reachable(url.replace(/^http:/, 'https:'))) {
        return url.replace(/^http:/, 'https:');
      }
      return url;
    }
    if (await this.reachable(url)) return url;
    const http = url.replace(/^https:/, 'http:');
    if (await this.reachable(http)) return http;
    return url;
  }

  private async reachable(url: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REACH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual', // a 3xx counts as reachable; never follow into other hosts
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (CourseRep portal check)' },
      });
      res.body?.cancel().catch(() => undefined);
      return res.status < 500;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
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
    this.assertCanConfirm(session.stage);

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

  private assertCanConfirm(stage: string) {
    if (stage !== 'PORTAL_SUGGESTED' && stage !== 'PORTAL_DISCOVERING') {
      throw new BadRequestException(`Cannot confirm portal from stage ${stage}`);
    }
  }
}
