import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveGeminiApiKey, visionFallbackEnabled } from './flag';
import { estimateNgn, estimateUsd } from './cost';

describe('vision fallback flag', () => {
  it('stays off unless the env or the session override turns it on, and never for demo sessions', () => {
    assert.equal(visionFallbackEnabled({}, {}), false);
    assert.equal(visionFallbackEnabled({ VISION_FALLBACK_ENABLED: 'false' }, {}), false);
    assert.equal(visionFallbackEnabled({ VISION_FALLBACK_ENABLED: 'true' }, {}), true);
    assert.equal(visionFallbackEnabled({}, { visionFallbackEnabled: true }), true);
    assert.equal(visionFallbackEnabled({ VISION_FALLBACK_ENABLED: 'true' }, { visionFallbackEnabled: false }), false);
    assert.equal(visionFallbackEnabled({ VISION_FALLBACK_ENABLED: 'true' }, { isDemo: true, visionFallbackEnabled: true }), false);
  });

  it('reads the Gemini key the rest of the agent already uses', () => {
    assert.equal(resolveGeminiApiKey({ GEMINI_API_KEY: ' gemini-key ' }), 'gemini-key');
    assert.equal(resolveGeminiApiKey({ GOOGLE_API_KEY: 'google-key' }), 'google-key');
    assert.equal(
      resolveGeminiApiKey({
        OPENAI_API_KEY: 'from-openai-slot',
        OPENAI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      }),
      'from-openai-slot',
    );
    assert.equal(resolveGeminiApiKey({ OPENAI_API_KEY: 'sk-openai' }), undefined);
  });

  it('prices gemini-3.8-flash at the published introductory rates', () => {
    assert.equal(estimateUsd(1_000_000, 1_000_000), 4.5);
    assert.equal(estimateNgn(1, 1600), 1600);
  });
});
