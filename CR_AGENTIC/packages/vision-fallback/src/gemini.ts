import { EXTRACTION_PROMPT, parseVisionCapture } from './extract';
import type { ComputerUseClient, FunctionResultInput, ModelFunctionCall, ModelTurn, VisionCapture } from './types';

const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

export class GeminiComputerUseClient implements ComputerUseClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async nextAction(input: {
    goalPrompt: string;
    screenshotPngBase64: string;
    previousInteractionId?: string;
    functionResults?: FunctionResultInput[];
    htmlExcerpt?: string;
  }): Promise<ModelTurn> {
    const tools = [{ type: 'computer_use', environment: 'browser', enable_prompt_injection_detection: true }];
    const body: Record<string, unknown> = { model: this.model, tools };
    if (input.previousInteractionId && input.functionResults && input.functionResults.length > 0) {
      body.previous_interaction_id = input.previousInteractionId;
      body.input = input.functionResults.map((result) => ({
        type: 'function_result',
        name: result.name,
        call_id: result.callId,
        result: [
          { type: 'text', text: JSON.stringify({ url: result.url, ...(result.error ? { error: result.error } : {}) }) },
          { type: 'image', data: result.screenshotPngBase64, mime_type: 'image/png' },
        ],
      }));
    } else {
      const inputParts: unknown[] = [
        { type: 'text', text: input.goalPrompt },
        { type: 'image', data: input.screenshotPngBase64, mime_type: 'image/png' },
      ];
      if (input.htmlExcerpt) {
        inputParts.push({ type: 'text', text: `Visible HTML excerpt:\n${input.htmlExcerpt.slice(0, 4000)}` });
      }
      body.input = inputParts;
    }
    return parseModelTurn(await this.post(INTERACTIONS_URL, body));
  }

  async extract(input: {
    screenshots: string[];
    htmlExcerpt: string;
  }): Promise<{ capture: VisionCapture; inputTokens: number; outputTokens: number }> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const parts: unknown[] = [{ text: EXTRACTION_PROMPT }];
    for (const data of input.screenshots) {
      parts.push({ inline_data: { mime_type: 'image/png', data } });
    }
    parts.push({ text: input.htmlExcerpt.slice(0, 12_000) });
    const json = await this.post(url, {
      contents: [{ role: 'user', parts }],
      generationConfig: { responseMimeType: 'application/json' },
    });
    const usage = readUsage(json);
    const text = collectGenerateText(json);
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {};
    }
    return {
      capture: parseVisionCapture(parsed),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
  }

  private async post(url: string, body: unknown): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Gemini ${response.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : {};
  }
}

export function parseModelTurn(body: unknown): ModelTurn {
  const root = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const usage = readUsage(root);
  const steps = Array.isArray(root.steps) ? root.steps : [];
  const calls: ModelFunctionCall[] = [];
  const texts: string[] = [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const row = step as Record<string, unknown>;
    const type = typeof row.type === 'string' ? row.type : '';
    if (type === 'function_call' || row.name && row.arguments) {
      const name = typeof row.name === 'string' ? row.name : '';
      if (!name) continue;
      const id = stringField(row.id) || stringField(row.call_id) || `call-${calls.length + 1}`;
      const args = row.arguments && typeof row.arguments === 'object' && !Array.isArray(row.arguments)
        ? (row.arguments as Record<string, unknown>)
        : {};
      calls.push({ id, name, arguments: args });
      continue;
    }
    const content = row.content ?? row.contents;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          texts.push((part as { text: string }).text);
        }
      }
    }
    if (typeof row.text === 'string') texts.push(row.text);
  }
  if (typeof root.text === 'string') texts.push(root.text);
  return {
    id: stringField(root.id),
    calls,
    text: texts.join('\n'),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}

function collectGenerateText(body: unknown): string {
  const root = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const candidates = Array.isArray(root.candidates) ? root.candidates : [];
  const texts: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const content = (candidate as { content?: { parts?: unknown[] } }).content;
    const parts = content?.parts ?? [];
    for (const part of parts) {
      if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
        texts.push((part as { text: string }).text);
      }
    }
  }
  return texts.join('\n');
}

export function readUsage(body: unknown): { inputTokens: number; outputTokens: number } {
  const root = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const usage = (root.usage ?? root.usage_metadata ?? root.usageMetadata ?? {}) as Record<string, unknown>;
  const input = firstNumber(usage, [
    'input_tokens',
    'inputTokens',
    'prompt_token_count',
    'promptTokenCount',
    'total_input_tokens',
  ]);
  const output = firstNumber(usage, [
    'output_tokens',
    'outputTokens',
    'candidates_token_count',
    'candidatesTokenCount',
    'total_output_tokens',
  ]);
  return { inputTokens: input, outputTokens: output };
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
