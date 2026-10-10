import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseModelTurn, readUsage } from './gemini';

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
});
