import {
  prisma,
  OnboardingStage,
  recordOnboardingTransition,
  getKnownStudentPortalUrl,
} from '@cr-agentic/database';
import { createLogger, writeAuditLog } from '@cr-agentic/observability';
import { PortalDiscoveryService, PortalCandidateResult } from '@cr-agentic/portal-discovery';
import { LmsType, portalMatchKey } from '@cr-agentic/shared';
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

  /**
   * Upsert by portal URL so candidate ids stay stable across discovery runs.
   * Clients hold these ids; replacing every row on a rerun made a student's
   * pick fail with "Portal candidate not found". Manual and selected rows are
   * never removed; web-search rows that are no longer suggested are.
   */
  private async persistCandidates(
    onboardingSessionId: string,
    candidates: PortalCandidateResult[],
  ): Promise<void> {
    const keyOf = (url: string) => portalMatchKey(url) ?? url.trim().toLowerCase();
    const existing = await prisma.portalCandidate.findMany({ where: { onboardingSessionId } });
    const byKey = new Map(existing.map((row) => [keyOf(row.loginUrl), row]));
    const keep = new Set<string>();

    for (const c of candidates) {
      const key = keyOf(c.loginUrl);
      if (keep.has(key)) continue;
      keep.add(key);
      const row = byKey.get(key);
      if (row) {
        if (row.source === 'MANUAL') continue;
        await prisma.portalCandidate.update({
          where: { id: row.id },
          data: {
            portalName: c.portalName,
            lmsType: c.lmsType,
            confidence: c.confidence,
            evidence: c.evidence,
          },
        });
        continue;
      }
      await prisma.portalCandidate.create({
        data: {
          onboardingSessionId,
          loginUrl: c.loginUrl,
          portalName: c.portalName,
          lmsType: c.lmsType,
          confidence: c.confidence,
          evidence: c.evidence,
          source: 'WEB_SEARCH' as const,
        },
      });
    }

    const stale = existing
      .filter((row) => row.source !== 'MANUAL' && !row.selected && !keep.has(keyOf(row.loginUrl)))
      .map((row) => row.id);
    if (stale.length > 0) {
      await prisma.portalCandidate
        .deleteMany({ where: { id: { in: stale } } })
        .catch((err) => logger.warn({ onboardingSessionId, err: String(err) }, 'stale candidate cleanup failed'));
    }
  }
}
