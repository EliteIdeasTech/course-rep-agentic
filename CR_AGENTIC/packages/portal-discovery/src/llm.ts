import type { LlmCompletionClient } from './types';

/**
 * OpenAI-backed JSON completion client. Kept self-contained so the discovery
 * worker only needs to provide an API key and model name.
 */
export class OpenAiCompletionClient implements LlmCompletionClient {
  private client: import('openai').default | null = null;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string,
    private readonly baseURL?: string,
    // Providers like OpenRouter reserve credit for the full max_tokens, so an
    // uncapped request can be rejected even when the reply is tiny.
    private readonly maxTokens = 2048,
  ) {}

  private getClient() {
    if (!this.client) {
      if (!this.apiKey) throw new Error('OPENAI_API_KEY not configured');
      const OpenAI = require('openai').default;
      this.client = new OpenAI({
        apiKey: this.apiKey,
        ...(this.baseURL ? { baseURL: this.baseURL } : {}),
      });
    }
    return this.client!;
  }

  async completeJson(systemPrompt: string, userPrompt: string): Promise<string> {
    const client = this.getClient();
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userPrompt },
    ];
    try {
      const response = await client.chat.completions.create({
        model: this.model,
        response_format: { type: 'json_object' },
        max_tokens: this.maxTokens,
        messages,
      });
      return response.choices[0]?.message?.content ?? '{}';
    } catch (err) {
      // Some OpenAI-compatible providers/models (e.g. certain OpenRouter
      // models) don't support strict json_object mode. Fall back to a plain
      // completion and best-effort JSON extraction.
      if (!isJsonModeUnsupported(err)) throw err;
      const response = await client.chat.completions.create({
        model: this.model,
        max_tokens: this.maxTokens,
        messages,
      });
      return extractJsonObject(response.choices[0]?.message?.content ?? '{}');
    }
  }
}

function isJsonModeUnsupported(err: unknown): boolean {
  const msg = (err as { message?: string })?.message?.toLowerCase() ?? '';
  return (
    msg.includes('response_format') ||
    msg.includes('json_object') ||
    msg.includes('json mode') ||
    msg.includes('not supported')
  );
}

/** Pull the first balanced JSON object/array out of a possibly fenced reply. */
function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.search(/[[{]/);
  if (start === -1) return '{}';
  const open = candidate[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    if (candidate[i] === open) depth++;
    else if (candidate[i] === close) {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return candidate.slice(start);
}
