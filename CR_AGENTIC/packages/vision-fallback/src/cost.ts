import { GEMINI_38_FLASH_USD_PER_MILLION } from './types';

export function estimateUsd(inputTokens: number, outputTokens: number): number {
  const input = Math.max(0, inputTokens) / 1_000_000 * GEMINI_38_FLASH_USD_PER_MILLION.input;
  const output = Math.max(0, outputTokens) / 1_000_000 * GEMINI_38_FLASH_USD_PER_MILLION.output;
  return input + output;
}

export function estimateNgn(usd: number, ngnPerUsd: number): number {
  if (!Number.isFinite(ngnPerUsd) || ngnPerUsd <= 0) return 0;
  return usd * ngnPerUsd;
}
