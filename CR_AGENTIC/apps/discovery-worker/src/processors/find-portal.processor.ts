import {
  prisma,
  OnboardingStage,
  recordOnboardingTransition,
  getKnownStudentPortalUrl,
} from '@cr-agentic/database';
import { createLogger, writeAuditLog } from '@cr-agentic/observability';
import { PortalDiscoveryService, PortalCandidateResult } from '@cr-agentic/portal-discovery';
import { LmsType } from '@cr-agentic/shared';
import type { DiscoveryFindPortalJob } from '@cr-agentic/shared';


const logger = createLogger('find-portal-processor');

export class FindPortalProcessor {
  constructor(private readonly discovery: PortalDiscoveryService) {}

  async process(job: { data: DiscoveryFindPortalJob }): Promise<void> {
    const { onboardingSessionId, userId } = job.data;

    const session = await prisma.onboardingSession.findUnique({
      where: { id: onboardingSessionId },
    });
    if (!session) throw new Error('Onboarding session not found');

    try {
      const knownPortalUrl = await getKnownStudentPortalUrl({
        universityId: session.universityId,
        universityName: session.universityName,
      });

      let candidates = await this.discovery.discover({
        universityName: job.data.universityName,
        country: job.data.country,
        website: job.data.website,
        knownPortalUrl: knownPortalUrl ?? undefined,
      });

      candidates = this.ensureKnownPortalFirst(candidates, knownPortalUrl);

      await this.persistCandidates(onboardingSessionId, candidates);

      // The user may have confirmed a portal while discovery was running.
      // Only move the session forward if it is still discovering.
      const current = await prisma.onboardingSession.findUnique({
        where: { id: onboardingSessionId },
        select: { stage: true },
      });
      if (current?.stage !== OnboardingStage.PORTAL_DISCOVERING) {
        logger.info(
          { onboardingSessionId, stage: current?.stage, count: candidates.length },
          'Portal discovery finished after session moved on; stage left unchanged',
        );
        return;
      }

      await recordOnboardingTransition(
        onboardingSessionId,
        current.stage as OnboardingStage,
        OnboardingStage.PORTAL_SUGGESTED,
        {
          candidateCount: candidates.length,
          knownPortalUrl: knownPortalUrl ?? null,
        },
      );

      await writeAuditLog({
        actorId: userId,
        action: 'portal_discovery_completed',
        resourceType: 'onboarding_session',
        resourceId: onboardingSessionId,
        metadata: {
          candidateCount: candidates.length,
          usedKnownPortal: Boolean(knownPortalUrl),
        },
      });

      logger.info(
        { onboardingSessionId, count: candidates.length, knownPortalUrl },
        'Portal discovery complete',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const latest = await prisma.onboardingSession.findUnique({
        where: { id: onboardingSessionId },
        select: { stage: true },
      });
      if (latest?.stage !== OnboardingStage.PORTAL_DISCOVERING) {
        logger.warn(
          { onboardingSessionId, stage: latest?.stage, err: message },
          'Portal discovery failed after session moved on; stage left unchanged',
        );
        return;
      }
      await recordOnboardingTransition(
        onboardingSessionId,
        latest.stage as OnboardingStage,
        OnboardingStage.FAILED,
        { error: message },
        { lastError: { stage: 'PORTAL_DISCOVERING', message } },
      );
      throw err;
    }
  }

  /**
   * If this school has a promoted known-good portal (>=5 successful logins),
   * put it first. Do not write studentPortalUrl from discovery rankings alone.
   */
  private ensureKnownPortalFirst(
    candidates: PortalCandidateResult[],
    knownPortalUrl: string | null,
  ): PortalCandidateResult[] {
    if (!knownPortalUrl) return candidates;
    const knownNorm = knownPortalUrl.replace(/\/+$/, '').toLowerCase();
    const rest = candidates.filter(
      (c) => c.loginUrl.replace(/\/+$/, '').toLowerCase() !== knownNorm,
    );
    const existing = candidates.find(
      (c) => c.loginUrl.replace(/\/+$/, '').toLowerCase() === knownNorm,
    );
    const head: PortalCandidateResult = existing
      ? {
          ...existing,
          confidence: Math.max(existing.confidence, 0.99),
          evidence: Array.from(
            new Set([...(existing.evidence || []), 'known-good-portal:5+ successful logins']),
          ),
        }
      : {
          loginUrl: knownPortalUrl,
          portalName: 'Known student portal',
          lmsType: LmsType.GENERIC,
          confidence: 0.99,
          evidence: ['known-good-portal:5+ successful logins'],
        };
    return [head, ...rest];
  }

  private async persistCandidates(
    onboardingSessionId: string,
    candidates: PortalCandidateResult[],
  ): Promise<void> {
    await prisma.portalCandidate.deleteMany({ where: { onboardingSessionId } });
    if (candidates.length === 0) return;
    await prisma.portalCandidate.createMany({
      data: candidates.map((c) => ({
        onboardingSessionId,
        loginUrl: c.loginUrl,
        portalName: c.portalName,
        lmsType: c.lmsType,
        confidence: c.confidence,
        evidence: c.evidence,
        source: 'WEB_SEARCH' as const,
      })),
    });
  }
}
