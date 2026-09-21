import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { prisma, OnboardingStage, Prisma } from '@cr-agentic/database';
import { writeAuditLog } from '@cr-agentic/observability';
import { assertTransition, isTerminal } from './onboarding-state-machine';
import { CourseRepClient } from '../../integrations/course-rep/course-rep.client';
import { StartOnboardingRequestDto } from './dto/onboarding.request.dto';
import { asSessionMetadata } from './onboarding-identity';

const ONBOARDING_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class OnboardingService {
  constructor(private readonly courseRep: CourseRepClient) {}

  async start(userId: string, dto: StartOnboardingRequestDto) {
    await this.courseRep.getUser(userId);

    const session = await prisma.onboardingSession.create({
      data: {
        userId,
        universityId: dto.universityId,
        universityName: dto.universityName,
        country: dto.country,
        website: dto.website,
        departmentName: dto.departmentName,
        academicLevelName: dto.academicLevelName,
        stage: 'UNIVERSITY_SELECTED',
        expiresAt: new Date(Date.now() + ONBOARDING_TTL_MS),
      },
    });

    await this.recordAudit(session.id, null, 'UNIVERSITY_SELECTED', {
      universityName: dto.universityName,
    });

    await writeAuditLog({
      actorId: userId,
      action: 'onboarding_started',
      resourceType: 'onboarding_session',
      resourceId: session.id,
      metadata: { universityId: dto.universityId, universityName: dto.universityName },
    });

    return { onboardingSessionId: session.id, stage: session.stage };
  }

  /**
   * School-first entry: create an onboarding session without a Course Rep
   * account. Uses a provisional UUID as userId until claim-identity remaps it.
   */
  async startGuest(
    dto: StartOnboardingRequestDto,
    guest: { token: string; tokenHash: string; expiresAt: Date },
  ) {
    const provisionalUserId = randomUUID();

    const session = await prisma.onboardingSession.create({
      data: {
        userId: provisionalUserId,
        universityId: dto.universityId,
        universityName: dto.universityName,
        country: dto.country,
        website: dto.website,
        departmentName: dto.departmentName,
        academicLevelName: dto.academicLevelName,
        stage: 'UNIVERSITY_SELECTED',
        expiresAt: new Date(Date.now() + ONBOARDING_TTL_MS),
        metadata: {
          isGuest: true,
          guestTokenHash: guest.tokenHash,
          guestTokenExpiresAt: guest.expiresAt.toISOString(),
        },
      },
    });

    // Patch guest token hash now that we know the session id — recreate bound to session.
    // Caller should issue the token with the session id; we accept pre-created hash
    // only when the start flow creates token after insert. See controller.
    await this.recordAudit(session.id, null, 'UNIVERSITY_SELECTED', {
      universityName: dto.universityName,
      guest: true,
    });

    await writeAuditLog({
      actorId: provisionalUserId,
      action: 'onboarding_started_guest',
      resourceType: 'onboarding_session',
      resourceId: session.id,
      metadata: { universityId: dto.universityId, universityName: dto.universityName },
    });

    return {
      onboardingSessionId: session.id,
      stage: session.stage,
      provisionalUserId,
    };
  }

  async attachGuestToken(
    sessionId: string,
    guest: { tokenHash: string; expiresAt: Date },
  ) {
    const session = await prisma.onboardingSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Onboarding session not found');
    await prisma.onboardingSession.update({
      where: { id: sessionId },
      data: {
        metadata: {
          ...asSessionMetadata(session.metadata),
          isGuest: true,
          guestTokenHash: guest.tokenHash,
          guestTokenExpiresAt: guest.expiresAt.toISOString(),
        },
      },
    });
  }

  async getStatus(userId: string, sessionId: string) {
    const session = await this.requireSession(userId, sessionId);
    const candidates = await prisma.portalCandidate.findMany({
      where: { onboardingSessionId: sessionId },
      orderBy: { confidence: 'desc' },
    });

    return {
      id: session.id,
      stage: session.stage,
      universityName: session.universityName,
      discoveryStatusByStage: {
        portalCandidates: candidates.length,
      },
      selectedCandidateId: session.selectedCandidateId,
      lastError: session.lastError,
      expiresAt: session.expiresAt,
      completedAt: session.completedAt,
      isTerminal: isTerminal(session.stage),
    };
  }

  async cancel(userId: string, sessionId: string) {
    const session = await this.requireSession(userId, sessionId);
    if (isTerminal(session.stage)) {
      return { stage: session.stage };
    }
    const updated = await this.transition(sessionId, session.stage, 'CANCELLED');

    await writeAuditLog({
      actorId: userId,
      action: 'onboarding_cancelled',
      resourceType: 'onboarding_session',
      resourceId: sessionId,
    });

    return { stage: updated.stage };
  }

  /** Loads a session scoped to the owning user, or throws 404. */
  async requireSession(userId: string, sessionId: string) {
    const session = await prisma.onboardingSession.findFirst({
      where: { id: sessionId, userId },
    });
    if (!session) throw new NotFoundException('Onboarding session not found');
    return session;
  }

  /**
   * Validates and applies a stage transition, persisting an audit row. Extra
   * fields (e.g. selectedCandidateId, lastError) can be set in the same write.
   */
  async transition(
    sessionId: string,
    from: OnboardingStage,
    to: OnboardingStage,
    data: Prisma.OnboardingSessionUpdateInput = {},
    detail?: Record<string, unknown>,
  ) {
    assertTransition(from, to);
    const updated = await prisma.onboardingSession.update({
      where: { id: sessionId },
      data: {
        stage: to,
        ...(to === 'ONBOARDING_COMPLETE' ? { completedAt: new Date() } : {}),
        ...data,
      },
    });
    await this.recordAudit(sessionId, from, to, detail);
    return updated;
  }

  private async recordAudit(
    sessionId: string,
    from: OnboardingStage | null,
    to: OnboardingStage,
    detail?: Record<string, unknown>,
  ) {
    await prisma.onboardingAuditEvent.create({
      data: {
        onboardingSessionId: sessionId,
        fromStage: from,
        toStage: to,
        detail: detail as Prisma.InputJsonValue | undefined,
      },
    });
  }
}
