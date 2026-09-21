# React App — Onboarding & LMS Integration Guideline

Complete integration guide for the Course Rep **React web app** to connect students to their university LMS portal, import courses and calendar events, and manage ongoing LMS connections via **CR_AGENTIC**.

> **Companion doc:** API request/response shapes are defined in [`mobile-sdk-contract.md`](./mobile-sdk-contract.md). This guide translates that contract into React architecture, routing, hooks, and web-specific login behavior.

---

## Table of contents

1. [What you are building](#1-what-you-are-building)
2. [Architecture](#2-architecture)
3. [Environment & configuration](#3-environment--configuration)
4. [Authentication](#4-authentication)
5. [Onboarding state machine](#5-onboarding-state-machine)
6. [Screen flow & routes](#6-screen-flow--routes)
7. [API reference](#7-api-reference)
8. [React implementation](#8-react-implementation)
9. [Login bridge (web-specific)](#9-login-bridge-web-specific)
10. [Post-onboarding LMS management](#10-post-onboarding-lms-management)
11. [Error handling & recovery](#11-error-handling--recovery)
12. [Security](#12-security)
13. [Local development](#13-local-development)
14. [Integration checklist](#14-integration-checklist)

---

## 1. What you are building

The onboarding flow lets a signed-in student:

1. Pick their university (main Course Rep API).
2. Discover or manually enter their student portal / LMS login URL (agent API).
3. Log in to the portal and capture an authenticated browser session (login bridge).
4. Scrape courses, grades/transcript, and calendar events from the LMS (agent workers).
5. Review and select what to import into Course Rep.
6. Sync selected data into the main app (courses, study-plan events, university portal cache).

After onboarding, the student has a **connected account** the agent can use for ongoing LMS sync, document downloads, and AI tasks.

---

## 2. Architecture

Your React app talks to **two backends**:

| Service | Base URL (local) | Auth | Purpose |
|---------|------------------|------|---------|
| **Main Course Rep API** | `http://localhost:3000/api` | JWT (`Authorization: Bearer`) | Users, universities, courses, study plans |
| **Agent API (CR_AGENTIC)** | `http://localhost:3100/api/v1/agent` | Same JWT | Onboarding, LMS connect, agent tasks |

```mermaid
flowchart LR
  subgraph React["React App"]
    UI[Onboarding UI]
    Client[API Clients]
  end

  subgraph Main["Main API :3000"]
    Uni[GET /universities]
    User[Users / Study Plan]
  end

  subgraph Agent["Agent API :3100"]
    OB[POST /onboarding/*]
    Bridge[POST /onboarding/login-bridge]
    Connect[GET /connected-accounts]
  end

  subgraph Workers["CR_AGENTIC Workers"]
    Discovery[discovery-worker]
    Browser[browser-worker]
    AI[ai-worker]
  end

  UI --> Client
  Client --> Uni
  Client --> OB
  Client --> Bridge
  Client --> Connect
  OB --> Discovery
  Bridge --> Browser
  Browser --> Main
  Discovery --> Main
```

**Data flow after sync:**

- Every scraped course → `POST /internal/courses/import-from-agent` (agent → main, server-side). Selected courses are `offered: true`; the rest are upserted unoffered.
- Calendar events → `POST /internal/study-plan/events`.
- Confirmed portal URL + LMS type → `POST /internal/universities/portal` (updates `University.studentPortalUrl`, `University.lmsType`).

The React app never calls `/internal/*` endpoints directly.

---

## 3. Environment & configuration

Add to your React app `.env` (Vite example):

```bash
VITE_COURSE_REP_API_URL=http://localhost:3000/api
VITE_AGENT_API_URL=http://localhost:3100/api/v1/agent
```

On the agent API side, ensure CORS allows your React origin:

```bash
# CR_AGENTIC/.env
CORS_ORIGIN=http://localhost:5173,https://app.courserep.com
```

| Variable | Where | Notes |
|----------|-------|-------|
| `VITE_COURSE_REP_API_URL` | React | Main API |
| `VITE_AGENT_API_URL` | React | Agent API |
| `CORS_ORIGIN` | agent-api | Comma-separated React app origins |
| `JWT_SECRET` | Both backends | Must match so the same token works on both |

Swagger for agent endpoints: `http://localhost:3100/api/docs/agent`

---

## 4. Authentication

All agent endpoints except **`POST /onboarding/login-bridge`** require the same JWT issued by the main Course Rep auth flow.

```typescript
// src/lib/agent-api.ts
const AGENT_BASE = import.meta.env.VITE_AGENT_API_URL;

export async function agentFetch<T>(
  path: string,
  options: RequestInit = {},
  token: string,
): Promise<T> {
  const res = await fetch(`${AGENT_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
    credentials: 'include',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new AgentApiError(res.status, body);
  }
  return res.json();
}
```

Store `onboardingSessionId` in React state (context or URL param) for the duration of the flow. Optionally persist to `sessionStorage` so a refresh mid-onboarding can resume:

```typescript
const ONBOARDING_KEY = 'cr:onboardingSessionId';

export function persistSessionId(id: string) {
  sessionStorage.setItem(ONBOARDING_KEY, id);
}

export function loadSessionId(): string | null {
  return sessionStorage.getItem(ONBOARDING_KEY);
}

export function clearSessionId() {
  sessionStorage.removeItem(ONBOARDING_KEY);
}
```

---

## 5. Onboarding state machine

Drive UI from the `stage` field returned by the agent API. Do not invent local-only states that skip server stages.

```
UNIVERSITY_SELECTED
  → PORTAL_DISCOVERING → PORTAL_SUGGESTED → PORTAL_CONFIRMED
  → AWAITING_LOGIN → LOGIN_IN_PROGRESS → SESSION_CAPTURED
  → DEEP_DISCOVERY → ONBOARDING_COMPLETE
```

**Recovery / terminal branches:**

| Stage | Meaning | UI action |
|-------|---------|-----------|
| `REAUTH_REQUIRED` | Session expired or validation failed | Restart login (`login/start`) |
| `FAILED` | Unrecoverable error; see `lastError` | Show error + retry from portal step or restart |
| `CANCELLED` | User aborted | Return to start |
| `ONBOARDING_COMPLETE` | Done | Clear persisted session id; navigate to dashboard |

Sessions expire **24 hours** after `POST /onboarding/start`. Poll `GET /onboarding/:sessionId` and check `expiresAt` / `isTerminal`.

---

## 6. Screen flow & routes

Suggested React Router structure:

| Route | Screen | Trigger stage(s) |
|-------|--------|------------------|
| `/onboarding` | Welcome / resume | Any non-terminal |
| `/onboarding/university` | University picker | — |
| `/onboarding/portal` | Portal discovery & confirm | `UNIVERSITY_SELECTED` … `PORTAL_CONFIRMED` |
| `/onboarding/login` | LMS login | `PORTAL_CONFIRMED` … `SESSION_CAPTURED` |
| `/onboarding/discover` | Scraping progress | `SESSION_CAPTURED`, `DEEP_DISCOVERY` |
| `/onboarding/review` | Select courses & events | `DEEP_DISCOVERY`, `ONBOARDING_COMPLETE` |
| `/onboarding/done` | Success | `ONBOARDING_COMPLETE` |
| `/settings/lms` | Connected accounts (post-onboarding) | — |

### Screen 1 — University picker

**Main API** (public, no auth required for search):

```
GET /api/universities
GET /api/universities/search?q=UNILAG
GET /api/universities/:id
```

Universities may already include cached portal info from prior onboardings:

```typescript
interface University {
  id: string;
  name: string;
  code: string;
  country?: string;
  website?: string;
  studentPortalUrl?: string;  // cached after first successful sync
  lmsType?: string;           // CANVAS | MOODLE | GENERIC | ...
  portalDiscoveryAt?: string;
}
```

If `studentPortalUrl` is present, you can skip portal discovery and offer “Use known portal” as a fast path (still call confirm + login).

Collect optional profile fields the agent uses for discovery context:

- `departmentName`
- `academicLevelName` (e.g. `"300 Level"`)

### Screen 2 — Start onboarding

```
POST /api/v1/agent/onboarding/start
```

```json
{
  "universityId": "uuid-from-main-api",
  "universityName": "University of Lagos",
  "country": "Nigeria",
  "website": "https://unilag.edu.ng",
  "departmentName": "Computer Science",
  "academicLevelName": "300 Level"
}
```

Response: `{ "onboardingSessionId": "uuid", "stage": "UNIVERSITY_SELECTED" }`

Persist `onboardingSessionId` and navigate to `/onboarding/portal`.

### Screen 3 — Portal discovery

1. `POST /onboarding/:sessionId/discover-portal`
2. Poll `GET /onboarding/:sessionId/portal-candidates` every **2–3 s** (back off to 30 s max) until:
   - candidates array is non-empty, or
   - `GET /onboarding/:sessionId` returns `stage === 'PORTAL_SUGGESTED'` or `FAILED`
3. Render candidates sorted by `confidence` (already sorted server-side).
4. User picks one → `POST /onboarding/:sessionId/confirm-portal` with `{ "candidateId": "uuid" }`.

**Manual fallback** when discovery finds nothing:

```
POST /onboarding/:sessionId/confirm-portal-manual
```

```json
{
  "loginUrl": "https://portal.university.edu/login",
  "lmsType": "MOODLE",
  "portalName": "Student Portal"
}
```

**Supported `lmsType` values:**

| Value | Platform |
|-------|----------|
| `CANVAS` | Instructure Canvas |
| `MOODLE` | Moodle |
| `BLACKBOARD` | Blackboard Learn |
| `BRIGHTSPACE` | D2L Brightspace |
| `GOOGLE_CLASSROOM` | Google Classroom |
| `GENERIC` | Unknown / custom portal |

Confirm response:

```json
{
  "connectedAccountId": "uuid",
  "stage": "PORTAL_CONFIRMED",
  "loginUrl": "https://portal.university.edu/login"
}
```

### Screen 4 — LMS login

See [§9 Login bridge (web-specific)](#9-login-bridge-web-specific).

High level:

1. `POST /onboarding/:sessionId/login/start` → `{ loginUrl, bridgeToken, expiresAt }`
2. User completes login in controlled browser surface.
3. `POST /onboarding/login-bridge` with captured `storageState` (no JWT).
4. Poll `GET /onboarding/:sessionId/login/status` until `status === 'captured'`.

### Screen 5 — Deep discovery

After login is captured:

1. `POST /onboarding/:sessionId/discover-academics`
2. Poll `GET /onboarding/:sessionId/discovery-results` until arrays are populated.

Response shape:

```typescript
interface DiscoveryResults {
  courses: DiscoveredCourse[];
  academicRecords: DiscoveredAcademicRecord[];
  calendarEvents: DiscoveredCalendarEvent[];
}

interface DiscoveredCourse {
  id: string;
  code: string | null;
  title: string;
  units: number | null;
  instructor: string | null;
  selected: boolean; // default true from worker; this is the offered flag
  offered: boolean; // same value as selected, explicit for the sync contract
}

interface DiscoveredCalendarEvent {
  id: string;
  title: string;
  eventType: string | null; // exam, assignment, ...
  startsAt: string | null;
  endsAt: string | null;
  selected: boolean;
}
```

Show a progress UI while `stage === 'DEEP_DISCOVERY'`. The worker chains: courses → transcript → calendar.

### Screen 6 — Review & import

Let the user toggle selections, then:

```
POST /onboarding/:sessionId/apply-results
```

```json
{
  "courseIds": ["uuid-of-every-discovered-course"],
  "offeredCourseIds": ["uuid-of-checked-course"],
  "offeredCodes": ["CSC301"],
  "calendarEventIds": ["uuid"]
}
```

`courseIds` is the full discovery list, in discovery order. `offeredCourseIds` and `offeredCodes` are the checked subset (`offeredCodes` may omit a checked course that has no code). The agent keeps every `courseIds` row in `discovered_courses` and sets `selected` / `offered` only for that subset. Assignments, timetable slots, and calendar events still use their own id lists as the selected subset.

Older clients that send only `courseIds` still work: those ids are the offered subset, and the other scraped courses stay stored unoffered. Omitting an array leaves that section’s selections unchanged.

Response includes the full discovery list so the client still has every scraped course when it calls sync:

```json
{
  "stage": "ONBOARDING_COMPLETE",
  "courses": [{ "id": "uuid", "code": "CSC301", "title": "Algorithms", "selected": true, "offered": true }],
  "discoveredCourseCount": 12,
  "offeredCourseCount": 4
}
```

**Sync to main app** (recommended, can be automatic after apply):

```
POST /onboarding/:sessionId/sync-to-course-rep
```

The same three course fields may be repeated on this body. The agent persists them, then sends **all** scraped courses to `POST /internal/courses/import-from-agent`. Each row has `offered` matching the checked subset. The main API must accept `offered` on `AgentCourseDto` (the live API still rejects unknown fields). It upserts departmental courses and offer/unoffers the student. A later sync sends the same course codes again and updates those records. Assignments, timetable slots, and calendar events are still only the selected ones (they become study-plan events).

```json
{
  "importedCourses": 12,
  "discoveredCourses": 12,
  "offeredCourses": 4,
  "unofferedCourses": 8,
  "syncedEvents": 3,
  "syncedEventsTotal": 3
}
```

`importedCourses` is the catalog upsert count (every scraped course), not the offered subset. This also updates the university’s cached portal fields.

### Cancel anytime

```
POST /onboarding/:sessionId/cancel
```

---

## 7. API reference

Base: `{VITE_AGENT_API_URL}` = `/api/v1/agent`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/onboarding/start` | JWT | Create session |
| `GET` | `/onboarding/:sessionId` | JWT | Full status snapshot |
| `POST` | `/onboarding/:sessionId/cancel` | JWT | Abort |
| `POST` | `/onboarding/:sessionId/discover-portal` | JWT | Start portal search |
| `GET` | `/onboarding/:sessionId/portal-candidates` | JWT | List suggestions |
| `POST` | `/onboarding/:sessionId/confirm-portal` | JWT | Confirm candidate |
| `POST` | `/onboarding/:sessionId/confirm-portal-manual` | JWT | Manual portal URL |
| `POST` | `/onboarding/:sessionId/login/start` | JWT | Issue bridge token |
| `GET` | `/onboarding/:sessionId/login/status` | JWT | Login progress |
| `POST` | `/onboarding/login-bridge` | Bridge token | Submit cookies (public) |
| `POST` | `/onboarding/:sessionId/discover-academics` | JWT | Start scrape |
| `GET` | `/onboarding/:sessionId/discovery-results` | JWT | Scraped data |
| `POST` | `/onboarding/:sessionId/apply-results` | JWT | Finalize selections |
| `POST` | `/onboarding/:sessionId/sync-to-course-rep` | JWT | Import to main app |
| `GET` | `/connected-accounts` | JWT | List LMS connections |
| `POST` | `/reconnect` | JWT | Re-auth existing account |
| `DELETE` | `/connected-accounts/:id` | JWT | Revoke connection |
| `POST` | `/connect-lms` | JWT | Direct connect (non-onboarding) |
| `POST` | `/agent/run` | JWT | Trigger agent task |

Status snapshot (`GET /onboarding/:sessionId`):

```typescript
interface OnboardingStatus {
  id: string;
  stage: OnboardingStage;
  universityName: string;
  discoveryStatusByStage: { portalCandidates: number };
  selectedCandidateId: string | null;
  lastError: Record<string, unknown> | null;
  expiresAt: string;
  completedAt: string | null;
  isTerminal: boolean;
}
```

---

## 8. React implementation

### Recommended module layout

```
src/
  features/
    onboarding/
      api/
        agent-onboarding.api.ts   # fetch wrappers
        types.ts                  # OnboardingStage, DTOs
      hooks/
        useOnboardingSession.ts   # load/resume session
        usePoll.ts                # generic poller
        usePortalDiscovery.ts
        useLoginBridge.ts
        useDiscoveryResults.ts
      components/
        UniversityPicker.tsx
        PortalCandidateList.tsx
        ManualPortalForm.tsx
        LmsLoginSurface.tsx
        DiscoveryProgress.tsx
        ImportReviewTable.tsx
      context/
        OnboardingProvider.tsx
      routes.tsx
    lms/
      ConnectedAccountsPage.tsx
      ReconnectBanner.tsx
```

### Types (`types.ts`)

Copy enums from `@cr-agentic/shared` or mirror them locally:

```typescript
export type OnboardingStage =
  | 'UNIVERSITY_SELECTED'
  | 'PORTAL_DISCOVERING'
  | 'PORTAL_SUGGESTED'
  | 'PORTAL_CONFIRMED'
  | 'AWAITING_LOGIN'
  | 'LOGIN_IN_PROGRESS'
  | 'SESSION_CAPTURED'
  | 'DEEP_DISCOVERY'
  | 'ONBOARDING_COMPLETE'
  | 'REAUTH_REQUIRED'
  | 'CANCELLED'
  | 'FAILED';

export type LmsType =
  | 'GENERIC'
  | 'CANVAS'
  | 'MOODLE'
  | 'BLACKBOARD'
  | 'BRIGHTSPACE'
  | 'GOOGLE_CLASSROOM';

export type LoginStatus = 'awaiting' | 'in_progress' | 'captured' | 'failed';
```

### Stage → route resolver

Centralize navigation so polling updates always land on the correct screen:

```typescript
export function routeForStage(stage: OnboardingStage): string {
  switch (stage) {
    case 'UNIVERSITY_SELECTED':
    case 'PORTAL_DISCOVERING':
    case 'PORTAL_SUGGESTED':
      return '/onboarding/portal';
    case 'PORTAL_CONFIRMED':
    case 'AWAITING_LOGIN':
    case 'LOGIN_IN_PROGRESS':
    case 'REAUTH_REQUIRED':
      return '/onboarding/login';
    case 'SESSION_CAPTURED':
    case 'DEEP_DISCOVERY':
      return '/onboarding/discover';
    case 'ONBOARDING_COMPLETE':
      return '/onboarding/review'; // or /onboarding/done after sync
    case 'FAILED':
    case 'CANCELLED':
      return '/onboarding';
    default:
      return '/onboarding';
  }
}
```

### Generic poll hook

```typescript
import { useEffect, useRef } from 'react';

export function usePoll<T>(
  fn: () => Promise<T>,
  shouldStop: (data: T) => boolean,
  intervalMs = 2500,
) {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let cancelled = false;
    let delay = intervalMs;

    const tick = async () => {
      if (cancelled) return;
      try {
        const data = await fnRef.current();
        if (shouldStop(data)) return;
      } catch {
        // surface via error boundary or local state
      }
      delay = Math.min(delay * 1.5, 30_000);
      setTimeout(tick, delay);
    };

    tick();
    return () => {
      cancelled = true;
    };
  }, [intervalMs]);
}
```

### Onboarding session hook (sketch)

```typescript
export function useOnboardingSession(token: string, sessionId: string | null) {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    const data = await agentFetch<OnboardingStatus>(
      `/onboarding/${sessionId}`,
      {},
      token,
    );
    setStatus(data);
    return data;
  }, [sessionId, token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { status, refresh };
}
```

Wire `refresh` after every mutating POST so the UI stage stays in sync.

### Portal discovery hook

```typescript
export async function runPortalDiscovery(token: string, sessionId: string) {
  await agentFetch(`/onboarding/${sessionId}/discover-portal`, { method: 'POST' }, token);

  return new Promise<PortalCandidate[]>((resolve, reject) => {
    let delay = 2500;
    const poll = async () => {
      const [candidates, status] = await Promise.all([
        agentFetch<PortalCandidate[]>(`/onboarding/${sessionId}/portal-candidates`, {}, token),
        agentFetch<OnboardingStatus>(`/onboarding/${sessionId}`, {}, token),
      ]);
      if (candidates.length > 0 || status.stage === 'FAILED') {
        resolve(candidates);
        return;
      }
      delay = Math.min(delay * 1.5, 30_000);
      setTimeout(poll, delay);
    };
    poll().catch(reject);
  });
}
```

### Import review component pattern

- Default all items with `selected: true` to checked.
- Track selected ids in local state.
- On submit call `apply-results`, then immediately `sync-to-course-rep`.
- Show partial success if sync returns counts lower than selected (server dedupes).

---

## 9. Login bridge (web-specific)

This is the most sensitive step. The agent API expects a **Playwright-compatible storage state**:

```typescript
interface StorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}
```

Reference: [Playwright storageState](https://playwright.dev/docs/api/class-browsercontext#browser-context-storage-state)

### Flow

```mermaid
sequenceDiagram
  participant React
  participant Agent as Agent API
  participant Popup as Login popup / WebView
  participant Worker as browser-worker

  React->>Agent: POST login/start (JWT)
  Agent-->>React: loginUrl, bridgeToken
  React->>Popup: Open loginUrl
  Note over Popup: Student completes SSO/MFA
  Popup->>React: storageState captured
  React->>Agent: POST login-bridge (bridgeToken)
  Agent->>Worker: validate session job
  loop Poll
    React->>Agent: GET login/status
  end
  Agent-->>React: status captured
```

### Critical browser limitation

**HttpOnly session cookies cannot be read from JavaScript** in a normal browser tab (`document.cookie` excludes them). Most LMS platforms (Moodle, Canvas, Blackboard) set HttpOnly session cookies.

| Runtime | Cookie access | Recommended |
|---------|---------------|-------------|
| **React Native / Capacitor WebView** | Native cookie store APIs | Primary mobile path — see mobile-sdk-contract |
| **Electron / Tauri desktop** | Full cookie access via native APIs | Supported |
| **Pure browser React (Chrome/Safari)** | Cannot export HttpOnly cookies | See strategies below |

### Strategies for pure web React

**Option A — Hybrid shell (recommended for production web)**

Ship the login step inside **Capacitor** or prompt users to complete login on **mobile** where the WebView bridge works. The React web app handles all other onboarding screens.

**Option B — Browser extension (future)**

A minimal extension with `cookies` permission for the portal domain can export full storage state and POST to `/onboarding/login-bridge`. Out of scope for Phase 1 but is the standard pattern for web-only LMS connectors.

**Option C — Best-effort popup (dev / limited portals only)**

Works only when the LMS session cookie is **not** HttpOnly (uncommon):

```typescript
export function openLoginPopup(loginUrl: string): Window | null {
  return window.open(
    loginUrl,
    'lms-login',
    'width=480,height=720,noopener,noreferrer',
  );
}

/** Call after detecting login success (URL heuristic or user clicks "I'm logged in"). */
export function captureBestEffortStorageState(portalOrigin: string): StorageState {
  const cookies = document.cookie.split(';').map((pair) => {
    const [name, ...rest] = pair.trim().split('=');
    return {
      name,
      value: rest.join('='),
      domain: new URL(portalOrigin).hostname,
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: 'Lax' as const,
    };
  });

  const localStorage: Array<{ name: string; value: string }> = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const name = window.localStorage.key(i)!;
    localStorage.push({ name, value: window.localStorage.getItem(name)! });
  }

  return {
    cookies,
    origins: localStorage.length ? [{ origin: portalOrigin, localStorage }] : [],
  };
}
```

Because the popup is cross-origin, you typically **cannot** read its cookies from the opener. This helper only works if login completes in the **same origin** as your app (almost never true). Document this clearly in UI copy and restrict to QA.

**Option D — Remote browser (Phase 2b)**

Server-hosted interactive browser session. Not available in Phase 1; show “use mobile app to connect” fallback.

### Submitting the bridge (no JWT)

```typescript
export async function submitLoginBridge(payload: {
  sessionId: string;
  bridgeToken: string;
  storageState: StorageState;
}) {
  const res = await fetch(`${AGENT_BASE}/onboarding/login-bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Login bridge failed');
  return res.json(); // { status: 'in_progress' }
}
```

Bridge token rules:

- Issued by `login/start`; expires **5 minutes** later.
- **Single use** — after a successful bridge POST, call `login/start` again if retrying.
- Never log or persist `bridgeToken` beyond the login step.

### Poll login status

```typescript
export async function waitForLoginCaptured(token: string, sessionId: string) {
  let delay = 2000;
  for (;;) {
    const { status, stage } = await agentFetch<{ status: LoginStatus; stage: string }>(
      `/onboarding/${sessionId}/login/status`,
      {},
      token,
    );
    if (status === 'captured') return;
    if (status === 'failed') throw new Error(`Login failed at stage ${stage}`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 30_000);
  }
}
```

On `captured`, enable “Continue” and auto-start deep discovery or navigate to `/onboarding/discover`.

---

## 10. Post-onboarding LMS management

After onboarding, expose LMS connections under **Settings → Connected accounts**.

### List connections

```
GET /api/v1/agent/connected-accounts
```

```typescript
interface ConnectedAccount {
  id: string;
  lmsType: LmsType;
  lmsBaseUrl: string;
  status: 'PENDING' | 'ACTIVE' | 'REAUTH_REQUIRED' | 'REVOKED';
  discoveryStatus: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETE' | 'FAILED';
  lastSyncAt: string | null;
  universityId: string | null;
}
```

Show a **`ReconnectBanner`** when `status === 'REAUTH_REQUIRED'`:

```
POST /api/v1/agent/reconnect
{ "connectedAccountId": "uuid" }
```

Then repeat the login bridge flow for that account (reuse `LmsLoginSurface` with account context).

### Revoke

```
DELETE /api/v1/agent/connected-accounts/:id
```

### Direct connect (skip full onboarding)

For power users who already know their portal URL:

```
POST /api/v1/agent/connect-lms
{ "lmsType": "CANVAS", "lmsBaseUrl": "https://canvas.university.edu" }
```

Still requires session capture via login bridge before the account becomes `ACTIVE`.

### Trigger agent tasks

```
POST /api/v1/agent/agent/run
{ "connectedAccountId": "uuid", "taskType": "SYNC_COURSES" }
```

Poll `GET /api/v1/agent/tasks/:id` for progress (optional dashboard UI).

---

## 11. Error handling & recovery

| Condition | Detection | UX |
|-----------|-----------|-----|
| Portal discovery empty | `stage === 'PORTAL_SUGGESTED'` + empty candidates | Show manual portal form |
| Discovery failed | `stage === 'FAILED'`, `lastError` set | Show message + “Try again” (`discover-portal`) |
| Bridge token expired | 401 on `login-bridge` | Re-call `login/start` |
| Login validation failed | `login/status → failed` or `REAUTH_REQUIRED` | Explain + restart login |
| Session expired | `expiresAt` in past | Start new onboarding |
| Sync partial failure | `importedCourses` < `discoveredCourses`, or `syncedEventsTotal` < selected events | Show what imported; offer retry sync |
| Network errors | fetch throws | Retry with backoff; keep stage in URL |

Always surface `lastError` from status when present — it is structured JSON from the worker.

```typescript
function OnboardingError({ lastError }: { lastError: Record<string, unknown> | null }) {
  if (!lastError) return null;
  const message =
    typeof lastError.message === 'string'
      ? lastError.message
      : 'Something went wrong connecting to your portal.';
  return <Alert variant="destructive">{message}</Alert>;
}
```

---

## 12. Security

1. **Never send the student’s password** to Course Rep or the agent API. Only post-login session material goes to `login-bridge`.
2. **TLS only** in production for both APIs and the bridge endpoint.
3. **Do not log** `bridgeToken`, cookie values, or full `storageState`.
4. Store JWT in memory or httpOnly cookie — not `localStorage` if avoidable.
5. Clear `sessionStorage` onboarding id on complete/cancel.
6. The bridge endpoint is public but gated by HMAC + single-use token tied to `sessionId`.
7. Captured sessions are encrypted at rest (AES-256-GCM) in S3 by the server.

---

## 13. Local development

### Start backends

```bash
# Terminal 1 — Main API
cd /path/to/course-rep-backend
yarn start:dev

# Terminal 2 — Agent infrastructure
cd CR_AGENTIC
docker compose -f docker/docker-compose.agent.yml up -d agent-postgres agent-redis
AGENT_DATABASE_URL=postgresql://agent:agent@localhost:5433/cr_agent?schema=public yarn db:migrate
yarn build:packages
yarn dev:agent-api      # :3100
yarn dev:browser-worker
yarn dev:discovery-worker
yarn dev:ai-worker
```

### Start React app

```bash
cd /path/to/course-rep-react
yarn dev   # ensure VITE_AGENT_API_URL points to :3100
```

### Test without real LMS

1. Walk through university + portal screens against a real university name.
2. For login bridge QA, use a portal where you control credentials, or mock at the network layer in tests.
3. Inspect agent Swagger at `http://localhost:3100/api/docs/agent`.
4. Verify CORS: browser devtools Network tab should show successful preflight to agent API.

### Polling reference

| After | Poll | Until |
|-------|------|-------|
| `discover-portal` | `portal-candidates` | non-empty or `FAILED` |
| `login-bridge` | `login/status` | `captured` or `failed` |
| `discover-academics` | `discovery-results` | courses/events populated |

Interval: start 2–3 s, exponential backoff to ~30 s.

---

## 14. Integration checklist

### Setup
- [ ] `VITE_COURSE_REP_API_URL` and `VITE_AGENT_API_URL` configured per environment
- [ ] Agent API `CORS_ORIGIN` includes React app origin(s)
- [ ] Same JWT works against both APIs

### Onboarding screens
- [ ] University search (`GET /universities`, `/search`)
- [ ] Start session (`POST /onboarding/start`) + persist session id
- [ ] Portal discovery with polling + manual fallback
- [ ] Portal confirm (`confirm-portal` / `confirm-portal-manual`)
- [ ] Login surface + bridge submit + login status polling
- [ ] Deep discovery trigger + results polling
- [ ] Review UI with course/event selection
- [ ] Apply results + sync to Course Rep
- [ ] Cancel + error states + session expiry handling
- [ ] Route guard maps `stage` → correct screen on refresh

### Post-onboarding
- [ ] Connected accounts list
- [ ] Reconnect flow for `REAUTH_REQUIRED`
- [ ] Revoke connection

### Security & UX
- [ ] No password fields sent to agent API
- [ ] Bridge token not logged
- [ ] Clear onboarding session storage on complete
- [ ] Loading/skeleton states for all async polls
- [ ] Accessible forms (manual portal entry, university search)

---

## Related docs

- [`mobile-sdk-contract.md`](./mobile-sdk-contract.md) — canonical API payloads
- [`../architecture/README.md`](../architecture/README.md) — system architecture & internal API
- [`../../README.md`](../../README.md) — CR_AGENTIC quick start
