import {
  COMPUTER_USE_MODEL,
  GEMINI_35_FLASH_LITE_USD_PER_MILLION,
  GEMINI_38_FLASH_USD_PER_MILLION,
} from './types';

/**
 * Price a token count for the model that produced it. An omitted model uses
 * the default flash-lite rates. A named model that is neither flash-lite nor
 * gemini-3.8-flash uses the higher 3.8 rates so a larger model is not underpriced.
 * Output tokens include thinking tokens; both models bill those at the output rate.
 */
export function estimateUsd(inputTokens: number, outputTokens: number, model?: string): number {
  const rates = ratesForModel(model);
  const input = Math.max(0, inputTokens) / 1_000_000 * rates.input;
  const output = Math.max(0, outputTokens) / 1_000_000 * rates.output;
  return input + output;
}

export function ratesForModel(model?: string): { input: number; output: number } {
  const name = (model ?? '').trim().toLowerCase();
  if (!name) return ratesForModel(COMPUTER_USE_MODEL);
  if (name.includes('flash-lite') || name.includes('flash_lite')) return GEMINI_35_FLASH_LITE_USD_PER_MILLION;
  if (name.includes('3.8') && name.includes('flash')) return GEMINI_38_FLASH_USD_PER_MILLION;
  return GEMINI_38_FLASH_USD_PER_MILLION;
}

export function estimateNgn(usd: number, ngnPerUsd: number): number {
  if (!Number.isFinite(ngnPerUsd) || ngnPerUsd <= 0) return 0;
  return usd * ngnPerUsd;
}
