import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runVisionLoop } from './loop';
import { CHALLENGE_ANSWER_PLACEHOLDER, type ComputerSurface, type ComputerUseClient, type VisionChallengeKind } from './types';

describe('human in the loop challenges', () => {
  it('types each student answer locally and keeps it out of the model and the logs', async () => {
    const answers = ['captcha-text', '482913'];
    const prompts: string[] = [];
    const typed: string[] = [];
    const modelPayloads: string[] = [];
    let phase: VisionChallengeKind | 'done' = 'captcha';
    const surface = surfaceWith(() => {
      if (phase === 'done') return null;
      const current = phase;
      return {
        kind: current,
        prompt: current === 'captcha' ? 'Enter the characters shown in the captcha image.' : 'Enter the verification code.',
      };
    }, typed);
    let modelCalls = 0;
    const client: ComputerUseClient = {
      async nextAction(input) {
        modelCalls += 1;
        modelPayloads.push(JSON.stringify(input));
        if (modelCalls === 1) {
          phase = 'otp';
          return { calls: [], text: 'USER_INPUT {"kind":"otp","prompt":"Enter the verification code."}', inputTokens: 10, outputTokens: 2 };
        }
        phase = 'done';
        return { calls: [], text: 'DONE', inputTokens: 10, outputTokens: 2 };
      },
      async extract() {
        return {
          capture: { profile: { displayName: 'Ada' }, courses: [] },
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    };

    const result = await runVisionLoop({
      surface,
      client,
      goal: 'login_and_extract',
      portalUrl: 'https://portal.example.edu/login',
      password: 's3cret-portal-pass',
      limits: { maxSteps: 10, timeoutMs: 10_000, tokenBudget: 10_000 },
      now: () => 0,
      awaitUserInput: async (challenge) => {
        prompts.push(challenge.prompt);
        assert.equal(JSON.stringify(challenge).includes(answers[0]), false);
        const answer = answers[prompts.length - 1] ?? 'x';
        return { status: 'answer', answer };
      },
    });

    assert.equal(result.status, 'CAPTURED');
    assert.deepEqual(typed, answers);
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0]?.includes('captcha'), true);
    const sent = modelPayloads.join('\n');
    for (const answer of answers) {
      assert.equal(sent.includes(answer), false);
      assert.equal(JSON.stringify(result.logs).includes(answer), false);
    }
    assert.equal(sent.includes('s3cret-portal-pass'), false);
  });

  it('fails clearly when the student does not answer before the timeout', async () => {
    let clock = 0;
    const surface = surfaceWith(
      () => ({ kind: 'security_question', prompt: "What is your mother's maiden name?" }),
      [],
    );
    const result = await runVisionLoop({
      surface,
      client: {
        async nextAction() {
          throw new Error('model must not be called');
        },
        async extract() {
          return { capture: { profile: {}, courses: [] }, inputTokens: 0, outputTokens: 0 };
        },
      },
      goal: 'login_and_extract',
      portalUrl: 'https://portal.example.edu/login',
      limits: { maxSteps: 5, timeoutMs: 10_000, tokenBudget: 10_000 },
      challengeTimeoutMs: 1_000,
      now: () => clock,
      awaitUserInput: async (challenge) => {
        assert.equal(challenge.kind, 'security_question');
        clock = Date.parse(challenge.expiresAt);
        return { status: 'timeout' };
      },
    });
    assert.equal(result.status, 'CHALLENGE_TIMEOUT');
    assert.equal(result.steps, 0);
  });

  it('substitutes the challenge placeholder without sending the answer', async () => {
    const typed: string[] = [];
    let visible = true;
    const surface = surfaceWith(() => (visible ? { kind: 'otp' as const, prompt: 'Enter the verification code.' } : null), typed);
    const sent: string[] = [];
    const result = await runVisionLoop({
      surface,
      client: {
        async nextAction(input) {
          sent.push(JSON.stringify(input));
          visible = false;
          return {
            calls: [{ id: 't', name: 'type', arguments: { text: CHALLENGE_ANSWER_PLACEHOLDER, intent: 'Fill the code box' } }],
            text: '',
            inputTokens: 5,
            outputTokens: 1,
          };
        },
        async extract() {
          return { capture: { profile: {}, courses: [] }, inputTokens: 0, outputTokens: 0 };
        },
      },
      goal: 'extract',
      portalUrl: 'https://portal.example.edu/home',
      limits: { maxSteps: 4, timeoutMs: 5_000, tokenBudget: 1_000 },
      now: () => 1,
      awaitUserInput: async () => ({ status: 'answer', answer: '998877' }),
    });
    assert.equal(typed.includes('998877'), true);
    assert.equal(typed.includes(CHALLENGE_ANSWER_PLACEHOLDER), false);
    assert.equal(sent.join('\n').includes('998877'), false);
    assert.notEqual(result.status, 'CHALLENGE_TIMEOUT');
  });
});

function surfaceWith(
  challenge: () => { kind: VisionChallengeKind; prompt: string } | null,
  typed: string[],
): ComputerSurface {
  return {
    viewport: () => ({ width: 1000, height: 800 }),
    url: () => 'https://portal.example.edu/login',
    screenshot: async () => Buffer.from('png'),
    htmlExcerpt: async () => '<form><input name="otp"></form>',
    elementAt: async () => null,
    passwordFieldVisible: async () => false,
    loginFormVisible: async () => false,
    challengeVisible: async () => challenge(),
    cropChallenge: async () => Buffer.from('crop'),
    focusChallenge: async () => true,
    click: async () => undefined,
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
}
