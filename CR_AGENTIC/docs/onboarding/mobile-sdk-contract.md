# Mobile Onboarding & WebView Login Bridge — SDK Contract

This document is the integration contract for the Course Rep mobile/web team. It
describes the onboarding screen flow and the exact request/response shapes the
client uses to drive CR_AGENTIC onboarding, including the WebView login bridge.

All endpoints are served by `agent-api` under the base path
`/api/v1/agent`. Authenticated endpoints expect the existing Course Rep JWT in
`Authorization: Bearer <token>`. The single public endpoint
(`/onboarding/login-bridge`) is authenticated by a one-time HMAC bridge token
instead.

## Onboarding stages

```
UNIVERSITY_SELECTED → PORTAL_DISCOVERING → PORTAL_SUGGESTED → PORTAL_CONFIRMED
  → AWAITING_LOGIN → LOGIN_IN_PROGRESS → SESSION_CAPTURED → DEEP_DISCOVERY
  → ONBOARDING_COMPLETE
```

`REAUTH_REQUIRED`, `CANCELLED`, and `FAILED` are recovery/terminal branches. The
client should poll status endpoints and render UI based on the current `stage`.

## Screen flow

1. **University picker** — existing `GET /api/universities`.
2. **Connect your school portal** — `POST /onboarding/start`.
3. **Portal suggestions** — `POST /onboarding/:sessionId/discover-portal`, poll
   `GET /onboarding/:sessionId/portal-candidates`, then
   `POST /onboarding/:sessionId/confirm-portal`.
4. **Login WebView** — `POST /onboarding/:sessionId/login/start`, open the
   returned `loginUrl` in a WebView, then post captured cookies to
   `POST /onboarding/login-bridge`. Poll `GET /onboarding/:sessionId/login/status`.
5. **Discovery progress** — `POST /onboarding/:sessionId/discover-academics`,
   poll `GET /onboarding/:sessionId/discovery-results`.
6. **Review imports** — `POST /onboarding/:sessionId/apply-results`, then
   optionally `POST /onboarding/:sessionId/sync-to-course-rep`.

## Endpoints

### 1. Start onboarding

`POST /onboarding/start`

```json
{
  "universityId": "uuid",
  "universityName": "University of Lagos",
  "country": "Nigeria",
  "website": "https://unilag.edu.ng",
  "departmentName": "Computer Science",
  "academicLevelName": "300 Level"
}
```

Response: `{ "onboardingSessionId": "uuid", "stage": "UNIVERSITY_SELECTED" }`

### 2. Portal discovery

- `POST /onboarding/:sessionId/discover-portal` → `{ "stage": "PORTAL_DISCOVERING" }`
- `GET /onboarding/:sessionId/portal-candidates`:

```json
[
  {
    "id": "uuid",
    "loginUrl": "https://portal.unilag.edu.ng/login",
    "lmsType": "MOODLE",
    "portalName": "Student Portal",
    "confidence": 0.92,
    "evidence": ["academic domain", "login form detected"],
    "source": "WEB_SEARCH"
  }
]
```

- `POST /onboarding/:sessionId/confirm-portal` with `{ "candidateId": "uuid" }`.
- `POST /onboarding/:sessionId/confirm-portal-manual` with
  `{ "loginUrl": "https://...", "lmsType": "GENERIC", "portalName": "..." }`
  when discovery returns nothing usable.

Confirm response: `{ "connectedAccountId": "uuid", "stage": "PORTAL_CONFIRMED", "loginUrl": "https://..." }`

### 3. Interactive login (WebView bridge)

`POST /onboarding/:sessionId/login/start`

Response:

```json
{
  "sessionId": "uuid",
  "loginUrl": "https://portal.unilag.edu.ng/login",
  "bridgeToken": "<nonce>.<expiresAtMs>.<hmac>",
  "expiresAt": "2026-06-29T10:05:00.000Z"
}
```

Client steps:

1. Open `loginUrl` in a full-screen WebView. Let the student complete SSO/MFA.
2. Detect successful login (URL change to a dashboard/home route, or a known
   post-login cookie). The portal-specific success heuristic is best-effort on
   the client; the server re-validates regardless.
3. Export the WebView's cookies and any `localStorage` origins into a
   **Playwright-compatible storage state** object (see below).
4. POST it to the public bridge endpoint.

#### `POST /onboarding/login-bridge` (public, no JWT)

```json
{
  "sessionId": "uuid",
  "bridgeToken": "<token from login/start>",
  "storageState": {
    "cookies": [
      {
        "name": "MoodleSession",
        "value": "abc123",
        "domain": "portal.unilag.edu.ng",
        "path": "/",
        "expires": 1790000000,
        "httpOnly": true,
        "secure": true,
        "sameSite": "Lax"
      }
    ],
    "origins": [
      {
        "origin": "https://portal.unilag.edu.ng",
        "localStorage": [{ "name": "key", "value": "val" }]
      }
    ]
  }
}
```

Response: `{ "status": "in_progress" }`

Notes and constraints:

- The `bridgeToken` is single-use and expires 5 minutes after `login/start`.
  After a successful bridge it is consumed; re-request via `login/start`.
- `storageState` must follow Playwright's
  [`storageState`](https://playwright.dev/docs/api/class-browsercontext#browser-context-storage-state)
  shape exactly (`cookies` + `origins`). The server hands this state to a
  headless browser for validation.
- `HttpOnly` cookies cannot be read by in-page JavaScript. On iOS use
  `WKHTTPCookieStore`; on Android use `CookieManager`/`CookieStore` to enumerate
  cookies for the portal domain, including HttpOnly ones, via a native bridge.
  If a portal relies on cross-domain SSO cookies the WebView cannot export, fall
  back to the Phase 2b remote-browser flow (out of scope for this contract).

#### `GET /onboarding/:sessionId/login/status`

Response: `{ "status": "awaiting" | "in_progress" | "captured" | "failed", "stage": "..." }`

Poll until `captured` (server validated the session) or `failed` (ask the user
to retry — re-run `login/start`).

### 4. Deep academic discovery

- `POST /onboarding/:sessionId/discover-academics` → `{ "stage": "DEEP_DISCOVERY", "discoveryStatus": "IN_PROGRESS" }`
- `GET /onboarding/:sessionId/discovery-results`:

```json
{
  "courses": [{ "id": "uuid", "code": "CSC301", "title": "Algorithms", "units": 3, "selected": true, "offered": true }],
  "academicRecords": [{ "id": "uuid", "cumulativeGpa": 4.32, "gradingScale": {}, "courseGrades": [] }],
  "calendarEvents": [{ "id": "uuid", "title": "Exam week", "eventType": "exam", "startsAt": "2026-07-01T00:00:00Z" }]
}
```

### 5. Review & sync

- `POST /onboarding/:sessionId/apply-results`:

```json
{
  "courseIds": ["<every discovered course id, in discovery order>"],
  "offeredCourseIds": ["<checked course ids>"],
  "offeredCodes": ["CSC301"],
  "assignmentIds": ["<checked assignment ids>"],
  "timetableSlotIds": ["<checked timetable ids>"],
  "calendarEventIds": ["<checked calendar event ids>"]
}
```

`courseIds` is the full discovered set and is stored in `discovered_courses`.
`offeredCourseIds` marks which of those rows are offered. `offeredCodes` is the
de-duplicated, non-empty codes of that subset (case-insensitive match). A
checked course with no code is still offered by id. Omitting `offeredCourseIds`
and `offeredCodes` keeps the older meaning of `courseIds`: those ids are the
offered subset, and the other scraped courses stay stored unoffered.

Assignment, timetable, and calendar id lists are still the checked subset only.

Response: `{ "stage": "ONBOARDING_COMPLETE", "courses": [ ...full discovery list ], "discoveredCourseCount": 12, "offeredCourseCount": 4 }`.
Each course includes `selected` and `offered` (the same flag).

- `POST /onboarding/:sessionId/sync-to-course-rep` accepts the same
  `courseIds`, `offeredCourseIds`, and `offeredCodes` body and persists that
  selection before import. Response:
  `{ "importedCourses": 12, "discoveredCourses": 12, "offeredCourses": 4, "unofferedCourses": 8, "syncedEvents": 3 }`.
  The import posts every scraped course to `POST /internal/courses/import-from-agent`
  with `offered` set from the subset above. That main-API field is not accepted
  until `course-rep-backend` adds `offered` to `AgentCourseDto`. Repeating sync
  updates those records. Selected calendar events are still pushed as study-plan
  events, and the confirmed portal is recorded on the `University` record.

### Session status (any time)

`GET /onboarding/:sessionId` returns the full status snapshot including `stage`,
`selectedCandidateId`, `lastError`, `expiresAt`, and `isTerminal`.

`POST /onboarding/:sessionId/cancel` aborts an in-progress onboarding.

## Polling guidance

| After | Poll | Until |
|-------|------|-------|
| `discover-portal` | `portal-candidates` | non-empty list or `stage == FAILED` |
| `login/start` + bridge | `login/status` | `captured` or `failed` |
| `discover-academics` | `discovery-results` | results populated (courses/records/events) |

Recommended interval: 2–3s with exponential backoff up to ~30s. Onboarding
sessions expire after 24 hours.

## Security notes

- Prefer `POST /onboarding/:sessionId/login/credentials` for web: the password
  is encrypted into Redis for ≤5 minutes, used once by Playwright, then deleted.
  Never write school passwords to Postgres, S3, or logs.
- Interactive login-bridge remains for SSO/MFA/captcha. Never send the school
  password to the bridge endpoint — only post-login `storageState`.
- The bridge token is HMAC-signed and bound to the `sessionId`; treat it as a
  secret and do not log it.
- Captured sessions are encrypted at rest (AES-256-GCM) in S3 by the server.
- Guest onboarding uses `X-Onboarding-Guest-Token` until `claim-identity`
  issues a Course Rep JWT.
