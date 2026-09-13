import { BadGatewayException, BadRequestException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { prisma } from '@cr-agentic/database';
import { enqueueJob } from '@cr-agentic/queue';
import { QUEUE_NAMES } from '@cr-agentic/shared';
import type { BrowserCredentialLoginJob } from '@cr-agentic/shared';
import { SessionCrypto } from '@cr-agentic/storage';
import { writeAuditLog } from '@cr-agentic/observability';
import { REDIS_CLIENT } from '../queue/queue.module';
import { SESSION_STORAGE } from './session-storage.provider';
import { SessionStorageService } from '@cr-agentic/storage';
import { OnboardingService } from './onboarding.service';
import {
  LoginBridgeRequestDto,
  CredentialLoginRequestDto,
} from './dto/onboarding.request.dto';
import {
  createBridgeToken,
  verifyBridgeToken,
  createGuestToken,
  verifyGuestToken,
} from './bridge-token';
import { CourseRepClient } from '../../integrations/course-rep/course-rep.client';

const BROWSER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CREDENTIALS_TTL_SEC = 300;
const CREDENTIALS_KEY_PREFIX = 'cr:agent:creds:';

@Injectable()
export class LoginService {
  private readonly bridgeSecret: string;
  private readonly crypto: SessionCrypto;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(SESSION_STORAGE) private readonly sessionStorage: SessionStorageService,
    private readonly onboarding: OnboardingService,
    private readonly courseRep: CourseRepClient,
    private readonly jwtService: JwtService,
    config: ConfigService,
  ) {
    this.bridgeSecret = config.get<string>('SESSION_ENCRYPTION_KEY', '');
    this.crypto = new SessionCrypto(this.bridgeSecret || 'dev-session-key');
  }

  /** Opens an interactive login: issues a short-lived bridge token + the portal URL. */
  async start(userId: string, sessionId: string) {
    const session = await this.onboarding.requireSession(userId, sessionId);
    if (!session.selectedCandidateId) {
      throw new BadRequestException('No confirmed portal for this session');
    }

    const candidate = await prisma.portalCandidate.findUnique({
      where: { id: session.selectedCandidateId },
    });
    if (!candidate) throw new NotFoundException('Confirmed portal not found');

    const { token, tokenHash, expiresAt } = createBridgeToken(
      sessionId,
      this.bridgeSecret,
    );

    await this.onboarding.transition(
      sessionId,
      session.stage,
      'AWAITING_LOGIN',
      { loginBridgeTokenHash: tokenHash, loginBridgeExpiresAt: expiresAt },
    );

    return {
      sessionId,
      loginUrl: candidate.loginUrl,
      bridgeToken: token,
      expiresAt,
    };
  }

  status(userId: string, sessionId: string) {
    return this.onboarding.requireSession(userId, sessionId).then((session) => ({
      status: this.mapStatus(session.stage),
      stage: session.stage,
    }));
  }

  /**
   * One-shot school credentials. Password is encrypted into Redis (5 min TTL)
   * and never written to Postgres/S3/logs. Browser worker performs the login.
   */
  async credentialLogin(
    userId: string,
    sessionId: string,
    dto: CredentialLoginRequestDto,
  ) {
    const session = await this.onboarding.requireSession(userId, sessionId);
    if (!session.selectedCandidateId) {
      throw new BadRequestException('No confirmed portal for this session');
    }

    const account = await prisma.connectedAccount.findFirst({
      where: { onboardingSessionId: sessionId },
      orderBy: { createdAt: 'desc' },
    });
    if (!account) throw new BadRequestException('No connected account to attach session');

    const credentialsRedisKey = `${CREDENTIALS_KEY_PREFIX}${sessionId}:${randomUUID()}`;
    const encrypted = this.crypto
      .encryptJson({
        username: dto.username,
        password: dto.password,
      })
      .toString('base64');

    await this.redis.set(credentialsRedisKey, encrypted, 'EX', CREDENTIALS_TTL_SEC);

    // Credential submit is one-shot: clients often skip login/start. Advance
    // PORTAL_CONFIRMED / REAUTH_REQUIRED -> AWAITING_LOGIN first.
    let stage = session.stage as string;
    if (stage === 'PORTAL_CONFIRMED' || stage === 'REAUTH_REQUIRED') {
      await this.onboarding.transition(sessionId, stage, 'AWAITING_LOGIN');
      stage = 'AWAITING_LOGIN';
    }
    if (stage !== 'AWAITING_LOGIN' && stage !== 'LOGIN_IN_PROGRESS') {
      throw new BadRequestException(
        `Cannot submit credentials from stage ${stage}`,
      );
    }

    await this.onboarding.transition(sessionId, stage, 'LOGIN_IN_PROGRESS');

    await enqueueJob<BrowserCredentialLoginJob>(
      QUEUE_NAMES.BROWSER_CREDENTIAL_LOGIN,
      this.redis,
      'credential-login',
      {
        connectedAccountId: account.id,
        onboardingSessionId: sessionId,
        userId,
        credentialsRedisKey,
      },
    );

    await writeAuditLog({
      actorId: userId,
      action: 'credential_login_started',
      resourceType: 'onboarding_session',
      resourceId: sessionId,
      metadata: { connectedAccountId: account.id },
    });

    return { status: 'in_progress' as const, stage: 'LOGIN_IN_PROGRESS' as const };
  }

  /**
   * After SESSION_CAPTURED (and ideally profile scrape), upsert a Course Rep
   * user from the portal profile and issue a JWT. Remaps guest sessions.
   */
  async claimIdentity(userId: string, sessionId: string) {
    const session = await this.onboarding.requireSession(userId, sessionId);
    const profile = await prisma.discoveredPortalProfile.findUnique({
      where: { onboardingSessionId: sessionId },
    });

    const email =
      profile?.email ||
      `portal-${sessionId.slice(0, 8)}@students.courserep.local`;
    const displayName = profile?.displayName ?? undefined;

    let upserted;
    try {
      upserted = await this.courseRep.upsertUserFromPortal({
      email,
      displayName,
      universityId: session.universityId ?? undefined,
      universityName: session.universityName,
      departmentName: profile?.departmentName ?? session.departmentName ?? undefined,
      academicLevelName:
        profile?.academicLevelName ?? session.academicLevelName ?? undefined,
      studentId: profile?.studentId ?? undefined,
    });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Course Rep identity upsert failed';
      throw new BadGatewayException(msg);
    }

    const realUserId = upserted.userId;

    // Remap all agent rows from guest/provisional userId → real userId.
    if (realUserId !== userId) {
      await prisma.$transaction([
        prisma.onboardingSession.update({
          where: { id: sessionId },
          data: {
            userId: realUserId,
            metadata: {
              ...((session.metadata as object) ?? {}),
              isGuest: false,
              previousUserId: userId,
              claimedAt: new Date().toISOString(),
            },
          },
        }),
        prisma.connectedAccount.updateMany({
          where: { onboardingSessionId: sessionId },
          data: { userId: realUserId },
        }),
        prisma.discoveredCourse.updateMany({
          where: { onboardingSessionId: sessionId },
          data: { userId: realUserId },
        }),
        prisma.discoveredAssignment.updateMany({
          where: { onboardingSessionId: sessionId },
          data: { userId: realUserId },
        }),
        prisma.discoveredTimetableSlot.updateMany({
          where: { onboardingSessionId: sessionId },
          data: { userId: realUserId },
        }),
        prisma.discoveredPortalProfile.updateMany({
          where: { onboardingSessionId: sessionId },
          data: { userId: realUserId },
        }),
        prisma.discoveredCalendarEvent.updateMany({
          where: { onboardingSessionId: sessionId },
          data: { userId: realUserId },
        }),
        prisma.discoveredAcademicRecord.updateMany({
          where: { onboardingSessionId: sessionId },
          data: { userId: realUserId },
        }),
      ]);
    }

    const accessToken = await this.jwtService.signAsync({
      sub: realUserId,
      email: upserted.email,
      username: upserted.username ?? upserted.email,
      roles: ['user'],
      permissions: [],
    });

    await writeAuditLog({
      actorId: realUserId,
      action: 'onboarding_identity_claimed',
      resourceType: 'onboarding_session',
      resourceId: sessionId,
    });

    return {
      userId: realUserId,
      email: upserted.email,
      accessToken,
      refreshToken: upserted.refreshToken ?? null,
      expiresIn: 3600,
      tokenType: 'Bearer' as const,
      user: {
        id: realUserId,
        email: upserted.email,
        universityId: upserted.universityId,
        departmentId: upserted.departmentId,
        academicLevelId: upserted.academicLevelId,
      },
    };
  }

  /**
   * Public endpoint hit by the mobile WebView. Authenticated solely by the
   * one-time HMAC bridge token (no JWT). Persists the captured storage state
   * and hands off to the browser worker for server-side validation.
   */
  async bridge(dto: LoginBridgeRequestDto) {
    const session = await prisma.onboardingSession.findUnique({
      where: { id: dto.sessionId },
    });
    if (!session) throw new NotFoundException('Onboarding session not found');

    const valid = verifyBridgeToken(
      dto.bridgeToken,
      dto.sessionId,
      this.bridgeSecret,
      session.loginBridgeTokenHash,
      session.loginBridgeExpiresAt,
    );
    if (!valid) throw new UnauthorizedException('Invalid or expired bridge token');

    const account = await prisma.connectedAccount.findFirst({
      where: { onboardingSessionId: session.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!account) throw new BadRequestException('No connected account to attach session');

    const s3Key = await this.sessionStorage.saveSession(
      account.id,
      Date.now().toString(),
      { cookies: dto.storageState.cookies, origins: dto.storageState.origins },
    );

    const browserSession = await prisma.browserSession.create({
      data: {
        connectedAccountId: account.id,
        storageStateS3Key: s3Key,
        expiresAt: new Date(Date.now() + BROWSER_SESSION_TTL_MS),
        status: 'ACTIVE',
      },
    });

    await this.onboarding.transition(
      session.id,
      session.stage,
      'LOGIN_IN_PROGRESS',
      { loginBridgeTokenHash: null, loginBridgeExpiresAt: null },
    );

    await enqueueJob(
      QUEUE_NAMES.BROWSER_VALIDATE_SESSION,
      this.redis,
      'validate',
      {
        connectedAccountId: account.id,
        onboardingSessionId: session.id,
        userId: session.userId,
        browserSessionId: browserSession.id,
      },
    );

    await writeAuditLog({
      actorId: session.userId,
      action: 'login_bridge_received',
      resourceType: 'onboarding_session',
      resourceId: session.id,
      metadata: { connectedAccountId: account.id },
    });

    return { status: 'in_progress' };
  }

  async complete(userId: string, sessionId: string) {
    const session = await this.onboarding.requireSession(userId, sessionId);
    return { status: this.mapStatus(session.stage), stage: session.stage };
  }

  /** Resolve session owner from JWT userId or guest token. */
  async resolveActor(
    sessionId: string,
    jwtUserId: string | undefined,
    guestToken: string | undefined,
  ): Promise<string> {
    const session = await prisma.onboardingSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) throw new NotFoundException('Onboarding session not found');

    if (jwtUserId && jwtUserId === session.userId) {
      return jwtUserId;
    }

    const meta = (session.metadata ?? {}) as {
      isGuest?: boolean;
      guestTokenHash?: string;
      guestTokenExpiresAt?: string;
    };

    if (guestToken && meta.guestTokenHash && meta.guestTokenExpiresAt) {
      const ok = verifyGuestToken(
        guestToken,
        sessionId,
        this.bridgeSecret,
        meta.guestTokenHash,
        new Date(meta.guestTokenExpiresAt),
      );
      if (ok) return session.userId;
    }

    if (jwtUserId) {
      // Allow JWT user that owns the session after claim remap
      const owned = await prisma.onboardingSession.findFirst({
        where: { id: sessionId, userId: jwtUserId },
      });
      if (owned) return jwtUserId;
    }

    throw new UnauthorizedException('Authentication required for this onboarding session');
  }

  issueGuestToken(sessionId: string): { token: string; tokenHash: string; expiresAt: Date } {
    return createGuestToken(sessionId, this.bridgeSecret);
  }

  private mapStatus(stage: string): 'awaiting' | 'in_progress' | 'captured' | 'failed' | 'needs_interactive' {
    switch (stage) {
      case 'AWAITING_LOGIN':
        return 'awaiting';
      case 'LOGIN_IN_PROGRESS':
        return 'in_progress';
      case 'SESSION_CAPTURED':
      case 'DEEP_DISCOVERY':
      case 'ONBOARDING_COMPLETE':
        return 'captured';
      case 'REAUTH_REQUIRED':
        return 'needs_interactive';
      case 'FAILED':
        return 'failed';
      default:
        return 'awaiting';
    }
  }
}
