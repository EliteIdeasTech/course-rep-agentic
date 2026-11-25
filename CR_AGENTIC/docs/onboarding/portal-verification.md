# Verified portal suggestions and test-account tagging

## Verified-only suggestions (`packages/portal-discovery`)

`PortalDiscoveryService.discoverDetailed()` opens every URL before it can be
suggested: the school's known portal, website-derived guesses, web-search hits,
and anything the LLM proposes. A URL is shown only when `verifyCandidate()`
(`src/verify.ts`) passes:

1. **Reachable**: resolves and answers. DNS/connection failures and 404/5xx are hidden.
   401/403/429/503 on the school's own portal host is kept and flagged
   `blockedFromServer` (geo/anti-bot block; the student signs in on the phone).
2. **Sign-in signal**: password form, LMS fingerprint, a portal host
   (`studentportal.*`, `portal.*`, `sis.*`, `lms.*`, …) or `/portalplus` path that
   renders a real page (many Nigerian portals are JS apps), or visible sign-in fields.
3. **Belongs to the school**: same country ccTLD (`Ghana → .gh`), the school's own
   website/known-portal domain, or a generic-TLD / hosted-LMS host carrying the
   school's name or acronym (`htu`, `unilag`, `marmara`).

The LLM is a tie-breaker only (≤ 0.05 confidence nudge between verified
candidates). With no LLM, verification + heuristics still work.

Unverified URLs that a student or the AI would have seen are returned as
`hidden` with a reason (`unreachable`, `http_error`, `no_login_signal`,
`other_country`, `other_school`, `cms_login`) and a student-facing message.
The discovery worker stores them on `onboarding_sessions.metadata.portalDiscovery.hidden`
and `GET /onboarding/:id` returns them as `hiddenPortals`.
Each candidate row stores `metadata.label` ("Student portal", "Moodle e-learning");
`GET /onboarding/:id/portal-candidates` returns `label`, `host`, `blockedFromServer`.

## School name validation

`POST /onboarding/start` and `/start-guest` reject a `universityName` that is an
email address (400, `universityName must be a school name, not an email address`).

## Test accounts (excluded from metrics)

Sessions get `metadata.testAccount = { isTest: true, reason }` when:

- the university is the reviewer demo school (`demo_university`),
- the signed-in user's email is a reviewer (`appreview*`, `reviewerapp*`), staff
  (`@courserep.ng/.org/.com`, or `ONBOARDING_TEST_ACCOUNT_EMAILS`), or `example.com`,
- the app sends `X-CR-Test-Account: test_lab | reviewer | staff | example_domain`
  (Firebase Test Lab / Play pre-launch devices, reviewer logins). Unknown values are ignored.

Exclude them in metrics queries:

```sql
SELECT stage, count(*)
FROM onboarding_sessions
WHERE coalesce((metadata->'testAccount'->>'isTest')::boolean, false) = false
  AND coalesce((metadata->>'isDemo')::boolean, false) = false
GROUP BY stage;
```

Sessions created before this change are not backfilled (no production data writes).
