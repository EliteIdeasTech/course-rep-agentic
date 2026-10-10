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
- `GET /internal/universities/:id` — **required on the main API, not shipped yet.** Same `InternalApiGuard` and `X-Internal-Secret` as the other internal routes. Return the university by id **including `isDemo: true` rows** (do not use the public list filter). Include `id`, `name`, and `isDemo`. `@SkipResponseTransform()` is preferred so the body is the entity; if the global interceptor still wraps it, the agent reads `data.isDemo` and `data.name`. A missing university is 404. Nest URL: `/api/internal/universities/:id`.
- `GET /universities/:id` — public fallback used only when the internal route 404s. Today this returns demo rows inside `{ success, data }`. Public lists already exclude them, and this GET may start excluding them too, so demo detection must not depend on it.
- `POST /internal/reviewer-demo/provision` — `{ userId, universityId }` for an `isDemo` university. Same `X-Internal-Secret` as import-from-agent. Nest serves it at `/api/internal/reviewer-demo/provision`.

## Vision fallback

`VISION_FALLBACK_ENABLED` defaults to false. When it is on, or a session's metadata `visionFallbackEnabled` is true, a failed scripted login or an empty course/profile scrape can run Gemini Computer Use (`gemini-3.5-flash-lite` by default, override with `VISION_FALLBACK_MODEL`, browser tool). The model types the placeholder `{{CR_PORTAL_PASSWORD}}`; the executor substitutes the password locally. Navigation stays on the portal's registrable domain. An OTP, captcha, or security question pauses the session as `AWAITING_USER_INPUT` until `POST /onboarding/:sessionId/challenge`. The answer is typed locally and is not sent to the model. The pause expires after `VISION_CHALLENGE_TIMEOUT_MS` (default 3 minutes) with `CHALLENGE_TIMEOUT`. Demo sessions never enable it.

Internal routes require header: `X-Internal-Secret: <INTERNAL_API_SECRET>`

## Standalone deployment & onboarding

- Infrastructure as code: [`infra/`](../../infra/README.md) (Terraform: VPC,
  RDS Postgres, ElastiCache, S3, ECS for 4 services, ALB, Secrets Manager).
- Onboarding API + WebView login bridge contract for the mobile team:
  [`docs/onboarding/mobile-sdk-contract.md`](../onboarding/mobile-sdk-contract.md).
- The `discovery-worker` service runs portal discovery and deep academic scrape
  jobs (`discovery.find-portal`, `discovery.deep-scrape`).
