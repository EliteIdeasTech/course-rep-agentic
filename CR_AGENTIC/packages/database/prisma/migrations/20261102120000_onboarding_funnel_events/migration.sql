-- Portal-connect funnel events (additive only; no existing table is altered).
CREATE TABLE "onboarding_funnel_events" (
    "id" UUID NOT NULL,
    "onboardingSessionId" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "step" TEXT,
    "fromStep" TEXT,
    "reason" TEXT,
    "rawReason" TEXT,
    "errorClass" TEXT,
    "httpStatus" INTEGER,
    "message" TEXT,
    "source" TEXT NOT NULL,
    "platform" TEXT,
    "appVersion" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "onboarding_funnel_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "onboarding_funnel_events_onboardingSessionId_createdAt_idx" ON "onboarding_funnel_events"("onboardingSessionId", "createdAt");
CREATE INDEX "onboarding_funnel_events_createdAt_idx" ON "onboarding_funnel_events"("createdAt");
CREATE INDEX "onboarding_funnel_events_event_reason_idx" ON "onboarding_funnel_events"("event", "reason");

ALTER TABLE "onboarding_funnel_events" ADD CONSTRAINT "onboarding_funnel_events_onboardingSessionId_fkey" FOREIGN KEY ("onboardingSessionId") REFERENCES "onboarding_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Read-only per-school, per-day (WAT) funnel. Built from onboarding_audit_events
-- so it also covers sessions from before the funnel table existed.
CREATE VIEW "portal_funnel_daily" AS
WITH s AS (
  SELECT
    os.id,
    lower(regexp_replace(trim(os."universityName"), '\s+', ' ', 'g')) AS school,
    ((os."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos')::date AS day,
    os.stage::text AS stage,
    (os.stage = 'ONBOARDING_COMPLETE') AS completed,
    (os.metadata ->> 'demo') IS NOT NULL OR os."universityName" ILIKE '%@%'
      OR os."universityName" ILIKE '%demo univ%' OR os."universityName" ILIKE '%test%' AS is_test,
    (SELECT max(CASE e."toStage"::text
        WHEN 'UNIVERSITY_SELECTED' THEN 0 WHEN 'PORTAL_DISCOVERING' THEN 1
        WHEN 'PORTAL_SUGGESTED' THEN 2 WHEN 'PORTAL_CONFIRMED' THEN 3
        WHEN 'AWAITING_LOGIN' THEN 4 WHEN 'LOGIN_IN_PROGRESS' THEN 5
        WHEN 'SESSION_CAPTURED' THEN 6 WHEN 'DEEP_DISCOVERY' THEN 7
        WHEN 'ONBOARDING_COMPLETE' THEN 8 END)
       FROM onboarding_audit_events e WHERE e."onboardingSessionId" = os.id) AS furthest_rank
  FROM onboarding_sessions os
)
SELECT
  school, day, is_test,
  count(*) AS sessions_started,
  count(*) FILTER (WHERE furthest_rank >= 2) AS reached_portal_suggested,
  count(*) FILTER (WHERE furthest_rank >= 3) AS reached_portal_accepted,
  count(*) FILTER (WHERE furthest_rank >= 5) AS reached_credentials_submitted,
  count(*) FILTER (WHERE furthest_rank >= 6) AS reached_session_captured,
  count(*) FILTER (WHERE completed) AS completed,
  round(count(*) FILTER (WHERE completed)::numeric / nullif(count(*), 0), 3) AS success_rate,
  count(*) FILTER (WHERE stage = 'CANCELLED') AS cancelled,
  count(*) FILTER (WHERE stage IN ('REAUTH_REQUIRED', 'FAILED')) AS login_blocked
FROM s
GROUP BY school, day, is_test;
