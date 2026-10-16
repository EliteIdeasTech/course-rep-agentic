import { JobsOptions } from 'bullmq';
import { QUEUE_NAMES } from '@cr-agentic/shared';

export interface QueuePolicy {
  concurrency: number;
  defaultJobOptions: JobsOptions;
  /** BullMQ worker lock duration ms. Deep scrape needs longer than the 2m default. */
  lockDuration?: number;
}

export const QUEUE_POLICIES: Record<string, QueuePolicy> = {
  [QUEUE_NAMES.BROWSER_CONNECT_LMS]: {
    concurrency: 5,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'fixed', delay: 30_000 },
      removeOnComplete: 1000,
      removeOnFail: false,
    },
  },
  [QUEUE_NAMES.BROWSER_REFRESH_SESSION]: {
    concurrency: 3,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 15_000 },
      removeOnComplete: 500,
    },
  },
  [QUEUE_NAMES.BROWSER_VALIDATE_SESSION]: {
    concurrency: 5,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'fixed', delay: 10_000 },
      removeOnComplete: 1000,
      removeOnFail: false,
    },
  },
  [QUEUE_NAMES.BROWSER_CREDENTIAL_LOGIN]: {
    concurrency: 5,
    defaultJobOptions: {
      // One-shot: credentials are deleted from Redis on first read, so a retry
      // can only fail (and used to overwrite the real outcome with FAILED).
      attempts: 1,
      removeOnComplete: 1000,
      removeOnFail: false,
    },
  },
  [QUEUE_NAMES.LMS_CHECK]: {
    concurrency: 20,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 2000,
    },
  },
  [QUEUE_NAMES.LMS_DOWNLOAD]: {
    concurrency: 10,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 2000,
    },
  },
  [QUEUE_NAMES.AI_SUMMARIZE]: {
    concurrency: 15,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
    },
  },
  [QUEUE_NAMES.AI_FLASHCARDS]: {
    concurrency: 15,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
    },
  },
  [QUEUE_NAMES.AI_QUIZ]: {
    concurrency: 10,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
    },
  },
  [QUEUE_NAMES.AI_PROCESS_DOCUMENT]: {
    concurrency: 10,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
    },
  },
  [QUEUE_NAMES.STUDY_PLAN_UPDATE]: {
    concurrency: 5,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'fixed', delay: 10_000 },
    },
  },
  [QUEUE_NAMES.NOTIFICATIONS_SEND]: {
    concurrency: 20,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
    },
  },
  [QUEUE_NAMES.DISCOVERY_FIND_PORTAL]: {
    concurrency: 5,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 1000,
    },
  },
  [QUEUE_NAMES.DISCOVERY_DEEP_SCRAPE]: {
    concurrency: 2,
    lockDuration: 600_000,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 15_000 },
      removeOnComplete: 1000,
      removeOnFail: false,
    },
  },
  [QUEUE_NAMES.AGENT_RETRY_FAILED]: {
    concurrency: 1,
    defaultJobOptions: { attempts: 1 },
  },
  [QUEUE_NAMES.AGENT_DLQ]: {
    concurrency: 1,
    defaultJobOptions: { attempts: 1, removeOnComplete: false },
  },
};

export function getQueuePolicy(queueName: string): QueuePolicy {
  return (
    QUEUE_POLICIES[queueName] ?? {
      concurrency: 5,
      defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    }
  );
}
