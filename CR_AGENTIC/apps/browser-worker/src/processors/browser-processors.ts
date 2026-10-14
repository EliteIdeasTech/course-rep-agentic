import { Job } from 'bullmq';
import { prisma, OnboardingStage, recordOnboardingTransition, recordSuccessfulPortalLogin } from '@cr-agentic/database';
import { createLogger, writeAuditLog, metrics, startSpan } from '@cr-agentic/observability';
import { UserLock, LmsRateLimiter, moveToDlq, enqueueJob } from '@cr-agentic/queue';
import { QUEUE_NAMES, AgentEventType } from '@cr-agentic/shared';
import type {
  BrowserConnectLmsJob,
  BrowserRefreshSessionJob,
  BrowserValidateSessionJob,
  LmsCheckJob,
  LmsDownloadJob,
} from '@cr-agentic/shared';
import { LmsAdapterRegistry } from '@cr-agentic/lms-adapters';
import { GenericPortalAdapter, CanvasAdapter, MoodleAdapter } from '@cr-agentic/lms-adapters';
import type { GenericPortalConfig } from '@cr-agentic/lms-adapters';
import { LmsType } from '@cr-agentic/shared';
import { createBrowserStack } from '../browser/browser-controller';
import Redis from 'ioredis';
import { createHash } from 'crypto';
import { SessionCrypto } from '@cr-agentic/storage';
import type { BrowserCredentialLoginJob } from '@cr-agentic/shared';
import {
  publishAndWaitForChallenge,
  runPortalVisionFallback,
  saveVisionCapture,
  type ChallengeRedis,
  type PlaywrightLikePage,
} from '@cr-agentic/vision-fallback';

const logger = createLogger('browser-processors');

export class BrowserProcessors {
  private readonly registry = new LmsAdapterRegistry();

  constructor(
    private readonly redis: Redis,
    private readonly stack = createBrowserStack(),
  ) {
    this.registry.register(new GenericPortalAdapter());
    this.registry.register(new CanvasAdapter());
    this.registry.register(new MoodleAdapter());
    void this.stack.controller.launch();
  }

  private adapter(lmsType: string) {
    try {
      return this.registry.get(lmsType as LmsType);
    } catch {
      return this.registry.get(LmsType.GENERIC);
    }
  }

  async processConnect(job: Job<BrowserConnectLmsJob>) {
    const lock = new UserLock(this.redis);
    return lock.withLock(job.data.userId, async () => {
      const span = startSpan('browser.connect-lms', { taskRunId: job.data.taskRunId });
      const { controller, s3 } = this.stack;

      await prisma.taskRun.update({
        where: { id: job.data.taskRunId },
        data: { status: 'RUNNING', startedAt: new Date(), workerId: process.pid.toString() },
      });

      const context = await controller.createContext();
      const page = await context.newPage();

      try {
        const adapter = this.adapter(job.data.lmsType);
        await page.goto(adapter.loginUrl(job.data.lmsBaseUrl), {
          waitUntil: 'domcontentloaded',
          timeout: 120_000,
        });

        const valid = await adapter.validateSession(page);
        if (!valid) {
          await prisma.connectedAccount.update({
            where: { id: job.data.connectedAccountId },
            data: { status: 'REAUTH_REQUIRED' },
          });
          throw new Error('Login not completed within validation window');
        }

        const { s3Key, expiresAt } = await controller.persistSession(
          job.data.connectedAccountId,
          context,
        );

        await prisma.browserSession.create({
          data: {
            connectedAccountId: job.data.connectedAccountId,
            storageStateS3Key: s3Key,
            expiresAt,
            lastValidatedAt: new Date(),
            status: 'ACTIVE',
          },
        });

        await prisma.connectedAccount.update({
          where: { id: job.data.connectedAccountId },
          data: { status: 'ACTIVE' },
        });

        await prisma.taskRun.update({
          where: { id: job.data.taskRunId },
          data: {
            status: 'COMPLETED',
            finishedAt: new Date(),
            result: { sessionS3Key: s3Key },
          },
        });

        await enqueueJob(QUEUE_NAMES.LMS_CHECK, this.redis, 'check', {
          connectedAccountId: job.data.connectedAccountId,
          userId: job.data.userId,
          taskId: job.data.taskId,
          taskRunId: job.data.taskRunId,
        });

        metrics.increment('browser.connect.success');
        await writeAuditLog({
          actorId: job.data.userId,
          action: 'browser_session_created',
          resourceType: 'connected_account',
          resourceId: job.data.connectedAccountId,
        });
      } catch (err) {
        const screenshotKey = await controller
          .captureScreenshot(page, job.data.taskRunId, s3, 'connect-failure')
          .catch(() => null);

        await prisma.taskRun.update({
          where: { id: job.data.taskRunId },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            error: { message: err instanceof Error ? err.message : String(err) },
            screenshotS3Keys: screenshotKey ? [screenshotKey] : [],
          },
        });
        metrics.increment('browser.connect.failure');
        throw err;
      } finally {
        await controller.releaseContext(context);
        span.end();
      }
    });
  }

  async processRefresh(job: Job<BrowserRefreshSessionJob>) {
    return this.processConnect(job as unknown as Job<BrowserConnectLmsJob>);
  }

  /**
   * Server-side username/password login. Credentials are read once from Redis
   * (encrypted), used to fill the portal form, then deleted. On MFA/SSO/captcha
   * the onboarding session flips to REAUTH_REQUIRED for interactive fallback.
   */
  async processCredentialLogin(job: Job<BrowserCredentialLoginJob>) {
    const lock = new UserLock(this.redis);
    return lock.withLock(job.data.userId, async () => {
      const { controller, env } = this.stack;
      const account = await prisma.connectedAccount.findUnique({
        where: { id: job.data.connectedAccountId },
      });
      if (!account) throw new Error('Connected account missing');

      const encryptedB64 = await this.redis.get(job.data.credentialsRedisKey);
      // Always delete — even on failure — so passwords never linger.
      await this.redis.del(job.data.credentialsRedisKey).catch(() => undefined);

      if (!encryptedB64) {
        await recordOnboardingTransition(
          job.data.onboardingSessionId,
          OnboardingStage.LOGIN_IN_PROGRESS,
          OnboardingStage.FAILED,
          { reason: 'credentials_expired' },
        );
        throw new Error('Credentials expired or missing');
      }

      const crypto = new SessionCrypto(env.SESSION_ENCRYPTION_KEY);
      let credentials: { username: string; password: string };
      try {
        credentials = crypto.decryptJson(Buffer.from(encryptedB64, 'base64'));
      } catch {
        await recordOnboardingTransition(
          job.data.onboardingSessionId,
          OnboardingStage.LOGIN_IN_PROGRESS,
          OnboardingStage.FAILED,
          { reason: 'credentials_decrypt_failed' },
        );
        throw new Error('Failed to decrypt credentials');
      }

      const config = await this.loadAdapterConfig(account.universityId, account.lmsType);
      const adapter = this.adapter(account.lmsType);
      const context = await controller.createContext();
      const page = await context.newPage();

      try {
        const candidate = account.portalCandidateId
          ? await prisma.portalCandidate.findUnique({ where: { id: account.portalCandidateId } })
          : null;
        const targetUrl = candidate?.loginUrl || adapter.loginUrl(account.lmsBaseUrl);
        await page.goto(targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 60_000,
        });

        let signedIn = adapter.attemptCredentialLogin
          ? await adapter.attemptCredentialLogin(page, credentials, config)
          : false;
        let interactiveReason = 'needs_interactive_login';

        if (!signedIn) {
          const onboarding = await prisma.onboardingSession.findUnique({
            where: { id: job.data.onboardingSessionId },
            select: { metadata: true },
          });
          const vision = await runPortalVisionFallback({
            env: process.env,
            metadata: onboarding?.metadata,
            page: page as unknown as PlaywrightLikePage,
            portalUrl: targetUrl,
            goal: 'login_and_extract',
            username: credentials.username,
            password: credentials.password,
            awaitUserInput: (challenge) =>
              publishAndWaitForChallenge(
                this.redis as unknown as ChallengeRedis,
                job.data.onboardingSessionId,
                challenge,
                { isSessionOpen: () => visionSessionStillOpen(job.data.onboardingSessionId) },
              ),
            onStep: (step) => {
              logger.info(
                {
                  onboardingSessionId: job.data.onboardingSessionId,
                  step: step.step,
                  action: step.action,
                  refused: step.refused,
                  inputTokens: step.inputTokens,
                  outputTokens: step.outputTokens,
                },
                'vision fallback step',
              );
            },
          });
          if (vision) {
            logger.info(
              {
                onboardingSessionId: job.data.onboardingSessionId,
                status: vision.status,
                steps: vision.steps,
                inputTokens: vision.inputTokens,
                outputTokens: vision.outputTokens,
                estimatedUsd: vision.estimatedUsd,
                latencyMs: vision.latencyMs,
                stopReason: vision.stopReason,
              },
              'vision fallback finished',
            );
            if (vision.status === 'SIGNED_IN' || vision.status === 'CAPTURED') {
              signedIn = true;
              await saveVisionCapture(
                prisma as unknown as Parameters<typeof saveVisionCapture>[0],
                { onboardingSessionId: job.data.onboardingSessionId, userId: job.data.userId },
                vision.capture,
              ).catch((err) => logger.warn({ err }, 'vision capture persist failed'));
            } else if (
              vision.status === 'CHALLENGE_TIMEOUT' ||
              vision.status === 'SESSION_EXPIRED' ||
              vision.status === 'AWAITING_USER_INPUT'
            ) {
              interactiveReason = vision.status;
            } else if (vision.status !== 'SKIPPED') {
              interactiveReason = vision.status;
            }
          }
        }

        if (!signedIn) {
          await prisma.connectedAccount.update({
            where: { id: account.id },
            data: { status: 'REAUTH_REQUIRED' },
          });
          await recordOnboardingTransition(
            job.data.onboardingSessionId,
            OnboardingStage.LOGIN_IN_PROGRESS,
            OnboardingStage.REAUTH_REQUIRED,
            { reason: interactiveReason },
            challengeFailure(interactiveReason),
          );
          metrics.increment('browser.credential_login.needs_interactive');
          return;
        }

        const { s3Key, expiresAt } = await controller.persistSession(account.id, context);
        await prisma.browserSession.create({
          data: {
            connectedAccountId: account.id,
            storageStateS3Key: s3Key,
            expiresAt,
            lastValidatedAt: new Date(),
            status: 'ACTIVE',
          },
        });
        await prisma.connectedAccount.update({
          where: { id: account.id },
          data: { status: 'ACTIVE' },
        });
        await recordOnboardingTransition(
          job.data.onboardingSessionId,
          OnboardingStage.LOGIN_IN_PROGRESS,
          OnboardingStage.SESSION_CAPTURED,
        );

        await this.rememberSuccessfulPortalLogin({
          onboardingSessionId: job.data.onboardingSessionId,
          universityId: account.universityId,
          loginUrl: targetUrl,
          lmsType: account.lmsType,
        });

        metrics.increment('browser.credential_login.success');
        await writeAuditLog({
          actorId: job.data.userId,
          action: 'credential_login_captured',
          resourceType: 'connected_account',
          resourceId: account.id,
        });
      } catch (err) {
        await recordOnboardingTransition(
          job.data.onboardingSessionId,
          OnboardingStage.LOGIN_IN_PROGRESS,
          OnboardingStage.REAUTH_REQUIRED,
          {
            reason: 'credential_login_error',
            message: err instanceof Error ? err.message : String(err),
          },
        ).catch(() => undefined);
        metrics.increment('browser.credential_login.failure');
        throw err;
      } finally {
        credentials.password = '';
        credentials.username = '';
        await controller.releaseContext(context);
      }
    });
  }

  /**
   * Validates a storage state captured via the onboarding login bridge. On
   * success the account becomes ACTIVE and onboarding advances to
   * SESSION_CAPTURED; otherwise the session is expired and the user is asked to
   * re-authenticate.
   */
  async processValidateSession(job: Job<BrowserValidateSessionJob>) {
    const lock = new UserLock(this.redis);
    return lock.withLock(job.data.userId, async () => {
      const { controller } = this.stack;
      const account = await prisma.connectedAccount.findUnique({
        where: { id: job.data.connectedAccountId },
      });
      const session = await prisma.browserSession.findUnique({
        where: { id: job.data.browserSessionId },
      });
      if (!account || !session) throw new Error('Account or browser session missing');

      const config = await this.loadAdapterConfig(account.universityId, account.lmsType);
      const adapter = this.adapter(account.lmsType);
      const context = await controller.createContext(session.storageStateS3Key);
      const page = await context.newPage();

      try {
        await page.goto(account.lmsBaseUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 60_000,
        });

        const valid = await adapter.validateSession(page, config);
        if (!valid) {
          await prisma.browserSession.update({
            where: { id: session.id },
            data: { status: 'EXPIRED' },
          });
          await prisma.connectedAccount.update({
            where: { id: account.id },
            data: { status: 'REAUTH_REQUIRED' },
          });
          await recordOnboardingTransition(
            job.data.onboardingSessionId,
            OnboardingStage.LOGIN_IN_PROGRESS,
            OnboardingStage.REAUTH_REQUIRED,
            { reason: 'session_validation_failed' },
          );
          metrics.increment('browser.validate.invalid');
          return;
        }

        await prisma.browserSession.update({
          where: { id: session.id },
          data: { lastValidatedAt: new Date() },
        });
        await prisma.connectedAccount.update({
          where: { id: account.id },
          data: { status: 'ACTIVE' },
        });
        await recordOnboardingTransition(
          job.data.onboardingSessionId,
          OnboardingStage.LOGIN_IN_PROGRESS,
          OnboardingStage.SESSION_CAPTURED,
        );

        const candidate = account.portalCandidateId
          ? await prisma.portalCandidate.findUnique({ where: { id: account.portalCandidateId } })
          : null;
        await this.rememberSuccessfulPortalLogin({
          onboardingSessionId: job.data.onboardingSessionId,
          universityId: account.universityId,
          loginUrl: candidate?.loginUrl || account.lmsBaseUrl,
          lmsType: account.lmsType,
        });

        metrics.increment('browser.validate.success');
        await writeAuditLog({
          actorId: job.data.userId,
          action: 'login_session_validated',
          resourceType: 'connected_account',
          resourceId: account.id,
        });
      } finally {
        await controller.releaseContext(context);
      }
    });
  }


  private async rememberSuccessfulPortalLogin(opts: {
    onboardingSessionId: string;
    universityId?: string | null;
    loginUrl: string;
    lmsType?: string | null;
  }): Promise<void> {
    try {
      const session = await prisma.onboardingSession.findUnique({
        where: { id: opts.onboardingSessionId },
      });
      if (!session?.universityName) return;
      const result = await recordSuccessfulPortalLogin({
        universityId: opts.universityId ?? session.universityId,
        universityName: session.universityName,
        loginUrl: opts.loginUrl,
        lmsType: opts.lmsType,
      });
      logger.info(
        {
          onboardingSessionId: opts.onboardingSessionId,
          count: result.count,
          promoted: result.promoted,
          studentPortalUrl: result.studentPortalUrl,
        },
        'Recorded portal login success for university cache',
      );
    } catch (err) {
      logger.warn({ err, onboardingSessionId: opts.onboardingSessionId }, 'Failed to record portal login success');
    }
  }

  private async loadAdapterConfig(
    universityId: string | null,
    lmsType: string,
  ): Promise<GenericPortalConfig | undefined> {
    const config = await prisma.portalAdapterConfig.findFirst({
      where: {
        lmsType: lmsType as never,
        OR: [{ universityId }, { universityId: null }],
      },
      orderBy: { universityId: { sort: 'desc', nulls: 'last' } },
    });
    if (!config) return undefined;
    return {
      selectors: (config.selectors as GenericPortalConfig['selectors']) ?? undefined,
      paths: (config.paths as GenericPortalConfig['paths']) ?? undefined,
    };
  }

  async processLmsCheck(job: Job<LmsCheckJob>) {
    const lock = new UserLock(this.redis);
    const limiter = new LmsRateLimiter(this.redis);

    return lock.withLock(job.data.userId, async () => {
      const account = await prisma.connectedAccount.findUnique({
        where: { id: job.data.connectedAccountId },
        include: {
          browserSessions: {
            where: { status: 'ACTIVE' },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      });
      if (!account?.browserSessions[0]) {
        throw new Error('No active browser session');
      }

      await limiter.waitForSlot(account.lmsBaseUrl);
      const adapter = this.adapter(account.lmsType);
      const { controller } = this.stack;
      const context = await controller.createContext(
        account.browserSessions[0].storageStateS3Key,
      );
      const page = await context.newPage();

      try {
        const valid = await adapter.validateSession(page);
        if (!valid) {
          await prisma.connectedAccount.update({
            where: { id: account.id },
            data: { status: 'REAUTH_REQUIRED' },
          });
          return;
        }

        const courses = await adapter.listCourses(page);
        for (const course of courses) {
          const materials = await adapter.listMaterials(page, course);
          for (const material of materials) {
            const existing = await prisma.lectureMaterial.findUnique({
              where: {
                connectedAccountId_externalId: {
                  connectedAccountId: account.id,
                  externalId: material.externalId,
                },
              },
            });
            if (existing) continue;

            const created = await prisma.lectureMaterial.create({
              data: {
                connectedAccountId: account.id,
                externalId: material.externalId,
                externalUrl: material.url,
                title: material.title,
                mimeType: material.mimeType,
                courseExternalId: material.courseExternalId,
                courseTitle: material.courseTitle,
              },
            });

            await prisma.outboxEvent.create({
              data: {
                eventType: AgentEventType.LECTURE_UPLOADED,
                aggregateId: created.id,
                payload: {
                  userId: job.data.userId,
                  lectureMaterialId: created.id,
                  title: created.title,
                },
              },
            });

            await enqueueJob(QUEUE_NAMES.LMS_DOWNLOAD, this.redis, 'download', {
              connectedAccountId: account.id,
              userId: job.data.userId,
              lectureMaterialId: created.id,
              taskId: job.data.taskId,
              taskRunId: job.data.taskRunId,
            });
          }
        }

        await prisma.connectedAccount.update({
          where: { id: account.id },
          data: { lastSyncAt: new Date() },
        });
      } finally {
        await controller.releaseContext(context);
      }
    });
  }

  async processDownload(job: Job<LmsDownloadJob>) {
    const lock = new UserLock(this.redis);
    return lock.withLock(job.data.userId, async () => {
      const material = await prisma.lectureMaterial.findUnique({
        where: { id: job.data.lectureMaterialId },
        include: {
          connectedAccount: {
            include: {
              browserSessions: {
                where: { status: 'ACTIVE' },
                orderBy: { createdAt: 'desc' },
                take: 1,
              },
            },
          },
        },
      });
      if (!material) throw new Error('Lecture material not found');

      const account = material.connectedAccount;
      const session = account.browserSessions[0];
      if (!session) throw new Error('No active session');

      await prisma.lectureMaterial.update({
        where: { id: material.id },
        data: { downloadStatus: 'DOWNLOADING' },
      });

      const adapter = this.adapter(account.lmsType);
      const { controller, s3 } = this.stack;
      const context = await controller.createContext(session.storageStateS3Key);
      const page = await context.newPage();

      try {
        const buffer = await adapter.downloadMaterial(page, {
          externalId: material.externalId,
          title: material.title,
          url: material.externalUrl ?? undefined,
        });

        const checksum = createHash('sha256').update(buffer).digest('hex');
        const docId = crypto.randomUUID();
        const s3Key = s3.documentKey(job.data.userId, docId, material.title);
        await s3.upload(s3Key, buffer, material.mimeType ?? 'application/octet-stream');

        const document = await prisma.agentDocument.create({
          data: {
            id: docId,
            lectureMaterialId: material.id,
            s3Key,
            checksum,
            fileSizeBytes: buffer.length,
            mimeType: material.mimeType,
            processingStatus: 'PENDING',
          },
        });

        await prisma.lectureMaterial.update({
          where: { id: material.id },
          data: { downloadStatus: 'COMPLETED' },
        });

        await enqueueJob(QUEUE_NAMES.AI_PROCESS_DOCUMENT, this.redis, 'process', {
          documentId: document.id,
          userId: job.data.userId,
          connectedAccountId: account.id,
          taskId: job.data.taskId,
        });
      } catch (err) {
        await prisma.lectureMaterial.update({
          where: { id: material.id },
          data: { downloadStatus: 'FAILED' },
        });
        throw err;
      } finally {
        await controller.releaseContext(context);
      }
    });
  }

  async handleFailure(queueName: string, job: Job, err: unknown) {
    if ((job.attemptsMade ?? 0) >= (job.opts.attempts ?? 1)) {
      await moveToDlq(this.redis, queueName, String(job.id), job.data, err);
    }
  }
}

function challengeFailure(reason: string): { lastError?: { code: string; message: string } } {
  if (reason === 'CHALLENGE_TIMEOUT') {
    return { lastError: { code: reason, message: 'The verification prompt expired before an answer arrived.' } };
  }
  if (reason === 'SESSION_EXPIRED') {
    return { lastError: { code: reason, message: 'The onboarding session expired while waiting for an answer.' } };
  }
  if (reason === 'AWAITING_USER_INPUT') {
    return { lastError: { code: reason, message: 'The portal is waiting for a code or captcha answer.' } };
  }
  return {};
}

async function visionSessionStillOpen(sessionId: string): Promise<boolean> {
  const row = await prisma.onboardingSession.findUnique({
    where: { id: sessionId },
    select: { expiresAt: true, stage: true },
  });
  if (!row) return false;
  if (row.expiresAt.getTime() <= Date.now()) return false;
  return row.stage !== 'CANCELLED' && row.stage !== 'FAILED';
}
