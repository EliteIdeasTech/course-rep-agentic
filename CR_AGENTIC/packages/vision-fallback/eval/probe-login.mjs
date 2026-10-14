/**
 * Offline and live probes for the vision fallback.
 *
 * Does not type credentials. A Gemini call happens only when GEMINI_API_KEY,
 * GOOGLE_API_KEY, GOOGLE_GENAI_API_KEY, or a Gemini OPENAI_BASE_URL key is set,
 * and only for find_login_form (no password is sent).
 *
 * Usage: node eval/probe-login.mjs
 */
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  estimateNgn,
  estimateUsd,
  playwrightSurface,
  resolveGeminiApiKey,
  runPortalVisionFallback,
  runVisionLoop,
  visionFallbackEnabled,
} from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const recorded = JSON.parse(
  readFileSync(join(here, '../src/fixtures/recorded-login-steps.json'), 'utf8'),
);

// Probe targets only. The fallback package does not branch on these hosts.
const PUBLIC_LOGIN_URLS = [
  'https://studentportal.unilag.edu.ng/',
  'https://portal.unilag.edu.ng/',
  'https://school.moodledemo.net/login/index.php',
  'https://demo.moodle.net/login/index.php',
];

const LOGIN_HTML = `<!doctype html>
<html>
  <head><title>Student portal</title></head>
  <body>
    <h1>Sign in</h1>
    <form action="/home" method="get">
      <label>Matric number <input name="username" type="text" /></label>
      <label>Password <input name="password" type="password" value="not-a-real-secret" /></label>
      <button type="submit">Sign in</button>
    </form>
  </body>
</html>`;

function hasKey() {
  return Boolean(resolveGeminiApiKey(process.env));
}

async function fxNgnPerUsd() {
  try {
    const response = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!response.ok) return null;
    const body = await response.json();
    const rate = body?.rates?.NGN;
    return typeof rate === 'number' && rate > 0 ? rate : null;
  } catch {
    return null;
  }
}

function report(name, result, extra = {}) {
  const row = {
    run: name,
    status: result?.status ?? 'SKIPPED_BY_FLAG',
    steps: result?.steps ?? 0,
    inputTokens: result?.inputTokens ?? 0,
    outputTokens: result?.outputTokens ?? 0,
    estimatedUsd: result?.estimatedUsd ?? 0,
    latencyMs: result?.latencyMs ?? 0,
    stopReason: result?.stopReason ?? null,
    geminiCalled: extra.geminiCalled ?? false,
    ...extra,
  };
  console.log(JSON.stringify(row));
  return row;
}

async function demoUniversityFlow() {
  const started = Date.now();
  const metadata = { isDemo: true, visionFallbackEnabled: true, universityName: 'Course Rep Demo University' };
  const env = { ...process.env, VISION_FALLBACK_ENABLED: 'true' };
  const enabled = visionFallbackEnabled(env, metadata);
  const outcome = await runPortalVisionFallback({
    env,
    metadata,
    page: {},
    portalUrl: 'https://portal.example.edu/login',
    goal: 'login_and_extract',
    username: 'appreview',
    password: 'reviewer-password-must-not-leave-the-process',
  });
  return report('demo-university', outcome, {
    latencyMs: Date.now() - started,
    visionFallbackEnabled: enabled,
    geminiCalled: false,
    note: 'isDemo sessions return before Playwright and before Gemini, even if the env flag and the session override are on.',
  });
}

async function recordedReplay() {
  const password = 's3cret-portal-pass';
  let cursor = 0;
  let passwordVisible = true;
  const surface = {
    viewport: () => ({ width: 1440, height: 900 }),
    url: () => 'https://portal.example.edu/login',
    screenshot: async () => Buffer.from(recorded.screenshot, 'base64'),
    htmlExcerpt: async () => '<form><input type="password"></form>',
    elementAt: async () => ({ text: 'Sign in', ariaLabel: '', href: '', tag: 'button', inputType: 'submit', role: '' }),
    passwordFieldVisible: async () => passwordVisible,
    loginFormVisible: async () => true,
    challengeVisible: async () => null,
    click: async () => {
      passwordVisible = false;
    },
    move: async () => undefined,
    typeText: async () => undefined,
    scroll: async () => undefined,
    navigate: async () => undefined,
    goBack: async () => undefined,
    goForward: async () => undefined,
    wait: async () => undefined,
    pressKey: async () => undefined,
  };
  const client = {
    async nextAction() {
      const call = recorded.steps[cursor];
      cursor += 1;
      if (!call) return { id: 'done', calls: [], text: 'DONE', inputTokens: 100, outputTokens: 20 };
      return { id: `turn-${cursor}`, calls: [call], text: '', inputTokens: 100, outputTokens: 20 };
    },
    async extract() {
      return {
        capture: {
          profile: { displayName: 'Ada Lovelace', studentId: 'CSC/19/001', departmentName: 'Computer Science', academicLevelName: '300' },
          courses: [{ externalId: 'vision-csc101', code: 'CSC101', title: 'Intro', units: 3 }],
          results: { cumulativeGpa: 4.2 },
        },
        inputTokens: 50,
        outputTokens: 30,
      };
    },
  };
  const result = await runVisionLoop({
    surface,
    client,
    goal: 'login_and_extract',
    portalUrl: 'https://portal.example.edu/login',
    username: 'student',
    password,
    limits: { maxSteps: 25, timeoutMs: 10_000, tokenBudget: 200_000 },
  });
  return report('recorded-fixture-replay', result, {
    geminiCalled: false,
    note: 'Token counts are the fixture client, not a live Gemini bill.',
  });
}

function serveLogin() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(LOGIN_HTML);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

async function probePage(browser, url, label) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const started = Date.now();
  let geminiCalled = false;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(1500);
    const surface = await playwrightSurface(page);
    const client = {
      async nextAction() {
        geminiCalled = true;
        return { calls: [], text: 'LOGIN_FORM_FOUND', inputTokens: 0, outputTokens: 0 };
      },
      async extract() {
        return { capture: { profile: {}, courses: [] }, inputTokens: 0, outputTokens: 0 };
      },
    };
    const result = await runVisionLoop({
      surface,
      client,
      goal: 'find_login_form',
      portalUrl: url,
      limits: { maxSteps: 3, timeoutMs: 20_000, tokenBudget: 1_000 },
    });
    const maskLeft = await page.locator('[data-cr-password-mask]').count();
    const shot = await surface.screenshot();
    const shotDir = process.env.VISION_PROBE_SCREENSHOT_DIR;
    if (shotDir && result.status === 'LOGIN_FORM_FOUND') {
      mkdirSync(shotDir, { recursive: true });
      const file = join(shotDir, `${label}.png`);
      writeFileSync(file, shot);
    }
    return report(label, result, {
      url: page.url(),
      geminiCalled,
      passwordMaskLeftBehind: maskLeft,
      screenshotBytes: shot.length,
      latencyMs: Date.now() - started,
      note: 'find_login_form returns before the model when a username field and a password field are already in the DOM. No credentials are typed.',
    });
  } catch (err) {
    return report(label, null, {
      url,
      status: 'FAILED',
      latencyMs: Date.now() - started,
      geminiCalled,
      stopReason: err instanceof Error ? err.message.slice(0, 240) : String(err),
    });
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function main() {
  const rate = await fxNgnPerUsd();
  const model = 'gemini-3.5-flash-lite';
  const ceilingInput = estimateUsd(200_000, 0, model);
  const ceilingOutput = estimateUsd(0, 200_000, model);
  console.log(JSON.stringify({
    run: 'budget-ceiling',
    model,
    tokenBudget: 200_000,
    maxSteps: 25,
    timeoutMs: 180_000,
    usdIfBudgetIsAllInput: ceilingInput,
    usdIfBudgetIsAllOutput: ceilingOutput,
    ngnPerUsd: rate,
    ngnIfBudgetIsAllInput: rate ? estimateNgn(ceilingInput, rate) : null,
    ngnIfBudgetIsAllOutput: rate ? estimateNgn(ceilingOutput, rate) : null,
    geminiKeyPresent: hasKey(),
    note: 'Default model gemini-3.5-flash-lite is $0.30 / 1M input and $2.50 / 1M output (output includes thinking tokens). gemini-3.8-flash is $0.75 / $3.75. The loop stops when input+output tokens reach the budget.',
  }));

  const rows = [];
  rows.push(await demoUniversityFlow());
  rows.push(await recordedReplay());

  const browser = await chromium.launch({ headless: true });
  try {
    const local = await serveLogin();
    try {
      rows.push(await probePage(browser, local.url, 'local-generic-login'));
    } finally {
      local.server.close();
    }
    let found = false;
    for (const url of PUBLIC_LOGIN_URLS) {
      const row = await probePage(browser, url, 'public-login');
      rows.push(row);
      if (row.status === 'LOGIN_FORM_FOUND') {
        found = true;
        break;
      }
    }
    if (!found) {
      console.log(JSON.stringify({ run: 'public-login', status: 'NO_FORM', note: 'None of the public URLs exposed a login form to the DOM detector.' }));
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
