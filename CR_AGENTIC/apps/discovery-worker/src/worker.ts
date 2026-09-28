import 'dotenv/config';
import { Job } from 'bullmq';
import { loadAgentEnv } from '@cr-agentic/config';
import { createRedisConnection, createWorker, moveToDlq } from '@cr-agentic/queue';
import { QUEUE_NAMES } from '@cr-agentic/shared';
import type { DiscoveryFindPortalJob, DiscoveryDeepScrapeJob } from '@cr-agentic/shared';
import { createLogger, metrics } from '@cr-agentic/observability';
import {
  PortalDiscoveryService,
  SerperSearchClient,
  OpenAiCompletionClient,
} from '@cr-agentic/portal-discovery';
import { FindPortalProcessor } from './processors/find-portal.processor';
import { DeepScrapeProcessor } from './processors/deep-scrape.processor';
import { prisma } from '@cr-agentic/database';
import { createDiscoveryBrowser } from './browser/discovery-browser';

const logger = createLogger('discovery-worker');

async function main() {
  const env = loadAgentEnv();
  const redis = createRedisConnection();

  const search = new SerperSearchClient(
    env.PORTAL_SEARCH_API_KEY,
    env.PORTAL_SEARCH_ENDPOINT,
  );
  const llm = new OpenAiCompletionClient(
    env.OPENAI_API_KEY,
    env.OPENAI_MODEL,
    env.OPENAI_BASE_URL,
  );
  // Navigation replies are one small JSON action; course lists need more room.
  const navLlm = new OpenAiCompletionClient(
    env.OPENAI_API_KEY,
    env.OPENAI_NAV_MODEL ?? env.OPENAI_MODEL,
    env.OPENAI_BASE_URL,
    400,
  );
  const extractLlm = new OpenAiCompletionClient(
    env.OPENAI_API_KEY,
    env.OPENAI_MODEL,
    env.OPENAI_BASE_URL,
    1500,
  );
  const discovery = new PortalDiscoveryService(search, llm);
  const findPortal = new FindPortalProcessor(discovery);

  const browser = createDiscoveryBrowser();
  const deepScrape = new DeepScrapeProcessor(redis, browser, extractLlm, navLlm);

  const workers = [
    createWorker<DiscoveryFindPortalJob>(
      QUEUE_NAMES.DISCOVERY_FIND_PORTAL,
      async (job) => {
        metrics.increment('discovery.find_portal.started');
        await findPortal.process(job);
        metrics.increment('discovery.find_portal.completed');
      },
    ),
    createWorker<DiscoveryDeepScrapeJob>(
      QUEUE_NAMES.DISCOVERY_DEEP_SCRAPE,
      async (job) => {
        metrics.increment('discovery.deep_scrape.started');
        await deepScrape.process(job);
        metrics.increment('discovery.deep_scrape.completed');
      },
    ),
  ];

  for (const worker of workers) {
    worker.on('failed', async (job: Job | undefined, err: Error) => {
      logger.error({ jobId: job?.id, err: err.message }, 'Discovery job failed');
      if (job && (job.attemptsMade ?? 0) >= (job.opts.attempts ?? 1)) {
        await moveToDlq(redis, worker.name, String(job.id), job.data, err);
        const accountId = (job.data as { connectedAccountId?: string })?.connectedAccountId;
        if (accountId && worker.name === QUEUE_NAMES.DISCOVERY_DEEP_SCRAPE) {
          await prisma.connectedAccount
            .update({
              where: { id: accountId },
              data: { discoveryStatus: 'FAILED' },
            })
            .catch(() => undefined);
        }
      }
    });
  }

  logger.info(
    { extractionModel: env.OPENAI_MODEL, navModel: env.OPENAI_NAV_MODEL ?? env.OPENAI_MODEL },
    'Discovery worker started',
  );

  const shutdown = async () => {
    await Promise.all(workers.map((w) => w.close()));
    await browser.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'Discovery worker crashed');
  process.exit(1);
});
