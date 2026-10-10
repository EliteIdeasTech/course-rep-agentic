import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { runVisionLoop } from './loop';
import { PASSWORD_PLACEHOLDER, type ComputerSurface, type ComputerUseClient, type ModelFunctionCall } from './types';

const recorded = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'recorded-login-steps.json'), 'utf8'),
) as {
  screenshot: string;
  steps: ModelFunctionCall[];
};

describe('offline recorded screenshot replay', () => {
  it('signs in from recorded steps without sending the password to the model', async () => {
    const password = 's3cret-portal-pass';
    const modelRequests: string[] = [];
    const typed: string[] = [];
    let passwordVisible = true;
    let stepCursor = 0;
    const surface: ComputerSurface = {
      viewport: () => ({ width: 1440, height: 900 }),
      url: () => 'https://portal.example.edu/login',
      screenshot: async () => Buffer.from(recorded.screenshot, 'base64'),
      htmlExcerpt: async () => '<form><input type="password" name="password"></form>',
      elementAt: async () => ({ text: 'Sign in', ariaLabel: '', href: '', tag: 'button', inputType: 'submit', role: '' }),
      passwordFieldVisible: async () => passwordVisible,
      loginFormVisible: async () => true,
      challengeVisible: async () => null,
      click: async () => {
        passwordVisible = false;
      },
      move: async () => undefined,
      typeText: async (text) => {
        typed.push(text);
      },
      scroll: async () => undefined,
      navigate: async () => undefined,
      goBack: async () => undefined,
      goForward: async () => undefined,
      wait: async () => undefined,
      pressKey: async () => undefined,
    };
    const client: ComputerUseClient = {
      async nextAction(input) {
        modelRequests.push(JSON.stringify(input));
        const call = recorded.steps[stepCursor];
        stepCursor += 1;
        if (!call) {
          return { id: 'done', calls: [], text: 'DONE', inputTokens: 100, outputTokens: 20 };
        }
        return { id: `turn-${stepCursor}`, calls: [call], text: '', inputTokens: 100, outputTokens: 20 };
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
      limits: { maxSteps: 25, timeoutMs: 10_000, tokenBudget: 10_000 },
      now: () => 0,
    });

    assert.equal(result.status, 'CAPTURED');
    assert.equal(typed.includes(password), true);
    assert.equal(typed.includes(PASSWORD_PLACEHOLDER), false);
    const sent = modelRequests.join('\n');
    assert.equal(sent.includes(password), false);
    assert.equal(sent.includes(PASSWORD_PLACEHOLDER), true);
    assert.equal(result.logs.some((log) => JSON.stringify(log).includes(password)), false);
    assert.equal(result.capture.courses[0]?.code, 'CSC101');
    assert.equal(result.steps, 4);
    assert.ok(result.inputTokens > 0);
  });

  it('stops at the step cap and on a captcha page', async () => {
    const surface: ComputerSurface = {
      viewport: () => ({ width: 1000, height: 1000 }),
      url: () => 'https://portal.example.edu/login',
      screenshot: async () => Buffer.from(recorded.screenshot, 'base64'),
      htmlExcerpt: async () => '<div>captcha</div>',
      elementAt: async () => null,
      passwordFieldVisible: async () => true,
      loginFormVisible: async () => true,
      challengeVisible: async () => 'captcha',
      click: async () => undefined,
      move: async () => undefined,
      typeText: async () => undefined,
      scroll: async () => undefined,
      navigate: async () => undefined,
      goBack: async () => undefined,
      goForward: async () => undefined,
      wait: async () => undefined,
      pressKey: async () => undefined,
    };
    let calls = 0;
    const client: ComputerUseClient = {
      async nextAction() {
        calls += 1;
        return { calls: [{ id: 'c', name: 'click', arguments: { x: 1, y: 1, intent: 'Click' } }], text: '', inputTokens: 10, outputTokens: 1 };
      },
      async extract() {
        return { capture: { profile: {}, courses: [] }, inputTokens: 0, outputTokens: 0 };
      },
    };
    const captcha = await runVisionLoop({
      surface,
      client,
      goal: 'login_and_extract',
      portalUrl: 'https://portal.example.edu/login',
      password: 's3cret-portal-pass',
      limits: { maxSteps: 25, timeoutMs: 5_000, tokenBudget: 1000 },
      now: () => 1,
    });
    assert.equal(captcha.status, 'CAPTCHA_REQUIRED');
    assert.equal(calls, 0);

    const spinning: ComputerSurface = { ...surface, challengeVisible: async () => null };
    let clock = 0;
    const capped = await runVisionLoop({
      surface: spinning,
      client,
      goal: 'extract',
      portalUrl: 'https://portal.example.edu/login',
      limits: { maxSteps: 3, timeoutMs: 5_000, tokenBudget: 100_000 },
      now: () => {
        clock += 1;
        return clock;
      },
    });
    assert.equal(capped.status, 'BUDGET_EXCEEDED');
    assert.ok(capped.steps <= 3);
  });
});
