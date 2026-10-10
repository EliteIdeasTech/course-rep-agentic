import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { budgetBlock, limitsFromEnv } from './budget';

describe('step and token budget', () => {
  it('defaults to 25 steps and stops on the cap, the token budget, and the timeout', () => {
    assert.equal(limitsFromEnv({}).maxSteps, 25);
    const limits = { maxSteps: 25, timeoutMs: 1_000, tokenBudget: 100 };
    const startedAt = 0;
    assert.equal(budgetBlock({ steps: 24, inputTokens: 10, outputTokens: 10, startedAt }, limits, 500), null);
    assert.equal(budgetBlock({ steps: 25, inputTokens: 0, outputTokens: 0, startedAt }, limits, 10), 'BUDGET_EXCEEDED');
    assert.equal(budgetBlock({ steps: 1, inputTokens: 80, outputTokens: 20, startedAt }, limits, 10), 'BUDGET_EXCEEDED');
    assert.equal(budgetBlock({ steps: 1, inputTokens: 0, outputTokens: 0, startedAt }, limits, 1_000), 'TIMEOUT');
  });
});
