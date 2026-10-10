import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildComputerUseRequest, GeminiComputerUseClient, parseModelTurn, readUsage } from './gemini';

describe('computer-use response parsing', () => {
  it('reads a browser function call and token usage from an interactions payload', () => {
    const turn = parseModelTurn({
      id: 'int_1',
      usage: { input_tokens: 1200, output_tokens: 80 },
      steps: [
        {
          type: 'function_call',
          id: 'c1',
          name: 'click',
          arguments: { x: 10, y: 20, intent: 'Click Sign in', safety_decision: { decision: 'regular' } },
        },
      ],
    });
    assert.equal(turn.id, 'int_1');
    assert.equal(turn.calls.length, 1);
    assert.equal(turn.calls[0]?.name, 'click');
    assert.equal(turn.calls[0]?.arguments.x, 10);
    assert.equal(turn.inputTokens, 1200);
    assert.equal(turn.outputTokens, 80);
    assert.deepEqual(readUsage({ usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } }), {
      inputTokens: 3,
      outputTokens: 1,
    });
  });

  it('adds thinking tokens onto output tokens', () => {
    assert.deepEqual(readUsage({ usage: { input_tokens: 100, output_tokens: 10, total_thought_tokens: 110 } }), {
      inputTokens: 100,
      outputTokens: 120,
    });
    assert.deepEqual(readUsage({ usageMetadata: { candidatesTokenCount: 4, thoughtsTokenCount: 8 } }), {
      inputTokens: 0,
      outputTokens: 12,
    });
    const turn = parseModelTurn({
      id: 'int_2',
      usage: { output_tokens: 5, totalThoughtTokens: 15 },
      steps: [],
    });
    assert.equal(turn.outputTokens, 20);
  });

  it('sends tools only on the first turn and labels visible page text', () => {
    const first = buildComputerUseRequest('gemini-3.5-flash-lite', {
      goalPrompt: 'Sign in',
      screenshotPngBase64: 'img-a',
      historyScreenshots: ['img-a', 'img-b', 'img-c', 'img-d'],
      htmlExcerpt: '<html><script>captcha</script></html> visible form',
    });
    assert.deepEqual(first.tools, [{
      type: 'computer_use',
      environment: 'browser',
      enable_prompt_injection_detection: true,
    }]);
    assert.equal(first.previous_interaction_id, undefined);
    const parts = first.input as Array<{ type: string; text?: string; data?: string }>;
    assert.deepEqual(parts.filter((part) => part.type === 'image').map((part) => part.data), ['img-b', 'img-c', 'img-d']);
    assert.equal(parts.some((part) => part.text?.startsWith('Visible page text:\n')), true);
    assert.equal(parts.some((part) => part.text?.includes('Visible HTML')), false);

    const followUp = buildComputerUseRequest('gemini-3.5-flash-lite', {
      goalPrompt: 'Sign in',
      screenshotPngBase64: 'img-e',
      previousInteractionId: 'int_1',
      functionResults: [{
        name: 'click',
        callId: 'c1',
        url: 'https://portal.example.edu/login',
        screenshotPngBase64: 'img-e',
      }],
    });
    assert.equal(followUp.tools, undefined);
    assert.equal(followUp.previous_interaction_id, 'int_1');
    assert.equal(Array.isArray(followUp.input), true);
  });

  it('retries 503 and 429 with backoff and does not retry a 400', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const client = new GeminiComputerUseClient('test-key', 'gemini-3.5-flash-lite', {
      retryDelaysMs: [5, 10, 20],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return new Response('unavailable', { status: 503 });
        if (calls === 2) return new Response('slow down', { status: 429 });
        return new Response(JSON.stringify({
          id: 'int_ok',
          usage: { input_tokens: 3, output_tokens: 1, total_thought_tokens: 2 },
          steps: [],
        }), { status: 200 });
      },
    });
    const turn = await client.nextAction({ goalPrompt: 'Find the form', screenshotPngBase64: 'png' });
    assert.equal(turn.id, 'int_ok');
    assert.equal(turn.outputTokens, 3);
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [5, 10]);

    let rejected = 0;
    const failing = new GeminiComputerUseClient('test-key', 'gemini-3.5-flash-lite', {
      retryDelaysMs: [5, 10, 20],
      sleep: async () => undefined,
      fetchImpl: async () => {
        rejected += 1;
        return new Response('safety violations', { status: 400 });
      },
    });
    await assert.rejects(
      () => failing.nextAction({ goalPrompt: 'Find the form', screenshotPngBase64: 'png' }),
      /Gemini 400: safety violations/,
    );
    assert.equal(rejected, 1);
  });
});
