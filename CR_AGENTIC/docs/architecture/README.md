# Phase 1 Architecture

CR_AGENTIC implements the approved Phase 1 architecture:

- Three deployable services under `apps/`
- Shared packages under `packages/`
- PostgreSQL agent schema via Prisma
- Integration with main Course Rep API via internal endpoints in `src/internal-api/`

## Internal API (main backend)

Configure `INTERNAL_API_SECRET` in both the main `.env` and `CR_AGENTIC/.env`.
Set `COURSE_REP_API_URL` to the main API origin **plus** the Nest global
`/api` prefix (e.g. `https://api.courserep.ng/api`). Agent clients keep path
strings as `/internal/...` and append them to that base.

Endpoints (behind the main API `/api` prefix):

- `GET /internal/users/:id`
- `POST /internal/materials/import-from-agent`
- `POST /internal/courses/import-from-agent`
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
