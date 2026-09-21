# Phase 1 Architecture

CR_AGENTIC implements the approved Phase 1 architecture:

- Three deployable services under `apps/`
- Shared packages under `packages/`
- PostgreSQL agent schema via Prisma
- Integration with main Course Rep API via internal endpoints in `src/internal-api/`

## Internal API (main backend)

Configure `INTERNAL_API_SECRET` in both the main `.env` and `CR_AGENTIC/.env`.

Endpoints:

- `GET /internal/users/:id`
- `POST /internal/materials/import-from-agent`
- `POST /internal/courses/import-from-agent` — upserts the full scraped catalog. Each course includes `offered`; only that subset becomes a student offering. Re-sync updates the same departmental course (`code` + department) in place. The live main API still rejects `offered` on `AgentCourseDto` (`forbidNonWhitelisted`) until the matching backend change ships. Agent `apply-results` and `sync-to-course-rep` accept `courseIds` (full discovery list), `offeredCourseIds`, and `offeredCodes` and persist that split before this call.
- `POST /internal/universities/portal`
- `POST /internal/study-plan/events`
- `POST /internal/study-plan/recompute`
- `POST /internal/notifications`

All require header: `X-Internal-Secret: <INTERNAL_API_SECRET>`

## Standalone deployment & onboarding

- Infrastructure as code: [`infra/`](../../infra/README.md) (Terraform: VPC,
  RDS Postgres, ElastiCache, S3, ECS for 4 services, ALB, Secrets Manager).
- Onboarding API + WebView login bridge contract for the mobile team:
  [`docs/onboarding/mobile-sdk-contract.md`](../onboarding/mobile-sdk-contract.md).
- The `discovery-worker` service runs portal discovery and deep academic scrape
  jobs (`discovery.find-portal`, `discovery.deep-scrape`).
