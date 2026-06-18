/**
 * Model adapters. A provider-agnostic ModelClient with one `complete` call.
 * Each adapter talks to its provider's API directly over `fetch` (no vendor SDK).
 *
 * When no API key is configured (or AGENT_MODEL=mock), we return a deterministic
 * MockClient so the entire pipeline runs offline.
 */
import type {
  CompleteArgs,
  CompleteResult,
  ContentBlock,
  Message,
  ModelClient,
  ModelSpec,
} from './types.js'

const DEFAULT_MAX_OUTPUT_TOKENS = 4096

export function resolveClient(model: ModelSpec): ModelClient {
  if (process.env.AGENT_MODEL === 'mock' || model.provider === 'mock') {
    return new MockClient()
  }

  const keyEnv =
    model.apiKeyEnv ?? (model.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY')
  if (process.env[keyEnv]) {
    return clientForProvider(model)
  }

  // The requested provider's key isn't set — try the other provider before
  // falling back to mock so that setting only OPENAI_API_KEY (or only
  // ANTHROPIC_API_KEY) still produces a real review.
  const altProvider = model.provider === 'openai' ? 'anthropic' : 'openai'
  const altKeyEnv = altProvider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'
  if (process.env[altKeyEnv]) {
    console.warn(
      `[agent] no ${keyEnv} set but ${altKeyEnv} found — using ${altProvider} provider`,
    )
    return clientForProvider({ ...model, provider: altProvider })
  }

  console.warn(`[agent] no ${keyEnv} set — falling back to mock model client`)
  return new MockClient()
}

function clientForProvider(model: ModelSpec): ModelClient {
  switch (model.provider) {
    case 'anthropic':
      return new AnthropicClient(model)
    case 'openai':
      return new OpenAIClient(model)
    default:
      throw new Error(`unknown model provider "${model.provider}"`)
  }
}

// ── Mock ───────────────────────────────────────────────────────────────────

class MockClient implements ModelClient {
  async complete(args: CompleteArgs): Promise<CompleteResult> {
    const isJudge = /judge/i.test(args.system)
    const text = isJudge
      ? JSON.stringify({
          verdict: 'approve',
          reason: 'Mock judge: no blocking findings (set an API key for a real review).',
          findings: [],
        })
      : [
          '- **severity**: info',
          '- **location**: (mock)',
          '- **note**: Mock review. Set ANTHROPIC_API_KEY or OPENAI_API_KEY for a real review.',
        ].join('\n')
    return {
      content: [{ type: 'text', text }],
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: 'end_turn',
    }
  }
}

// ── Anthropic ──────────────────────────────────────────────────────────────

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

class AnthropicClient implements ModelClient {
  constructor(private readonly model: ModelSpec) {}

  async complete(args: CompleteArgs): Promise<CompleteResult> {
    const apiKey = process.env[this.model.apiKeyEnv ?? 'ANTHROPIC_API_KEY']
    if (!apiKey) throw new Error('Anthropic API key missing')

    const body = {
      model: args.model.model,
      system: args.system,
      max_tokens: args.sampling?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      ...(args.sampling?.temperature !== undefined ? { temperature: args.sampling.temperature } : {}),
      messages: args.messages.map(toAnthropicMessage),
      ...(args.tools.length > 0
        ? {
            tools: args.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema,
            })),
          }
        : {}),
    }

    const res = await fetch(this.model.baseURL ?? ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: args.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 500)}`)
    }

    const json = (await res.json()) as AnthropicResponse
    return {
      content: json.content.map(fromAnthropicBlock),
      usage: {
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
      },
      stopReason: json.stop_reason ?? 'end_turn',
    }
  }
}

interface AnthropicResponse {
  content: AnthropicBlock[]
  stop_reason?: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: string; [k: string]: unknown }

function toAnthropicMessage(msg: Message): { role: 'user' | 'assistant'; content: unknown[] } {
  const role = msg.role === 'assistant' ? 'assistant' : 'user'
  return { role, content: msg.content.map(toAnthropicBlock) }
}

function toAnthropicBlock(block: ContentBlock): unknown {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        ...(block.isError ? { is_error: true } : {}),
      }
  }
}

function fromAnthropicBlock(block: AnthropicBlock): ContentBlock {
  if (block.type === 'text') return { type: 'text', text: (block as { text: string }).text }
  if (block.type === 'tool_use') {
    const b = block as { id: string; name: string; input: unknown }
    return { type: 'tool_use', id: b.id, name: b.name, input: b.input }
  }
  return { type: 'text', text: JSON.stringify(block) }
}

// ── OpenAI ─────────────────────────────────────────────────────────────────

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

class OpenAIClient implements ModelClient {
  constructor(private readonly model: ModelSpec) {}

  async complete(args: CompleteArgs): Promise<CompleteResult> {
    const apiKey = process.env[this.model.apiKeyEnv ?? 'OPENAI_API_KEY']
    if (!apiKey) throw new Error('OpenAI API key missing')

    const messages: OpenAIMessage[] = [
      { role: 'system', content: args.system },
      ...args.messages.flatMap(toOpenAIMessages),
    ]

    const body: Record<string, unknown> = {
      model: args.model.model,
      messages,
      max_tokens: args.sampling?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      ...(args.sampling?.temperature !== undefined ? { temperature: args.sampling.temperature } : {}),
      ...(args.tools.length > 0
        ? {
            tools: args.tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
    }

    const res = await fetch(this.model.baseURL ?? OPENAI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: args.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`OpenAI API ${res.status}: ${text.slice(0, 500)}`)
    }

    const json = (await res.json()) as OpenAIChatResponse
    const choice = json.choices?.[0]
    if (!choice) throw new Error('OpenAI returned no choices')

    return {
      content: fromOpenAIChoice(choice),
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      },
      stopReason: choice.finish_reason ?? 'stop',
    }
  }
}

type OpenAIRole = 'system' | 'user' | 'assistant' | 'tool'

interface OpenAIMessage {
  role: OpenAIRole
  content?: string | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface OpenAIChatResponse {
  choices?: OpenAIChoice[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

interface OpenAIChoice {
  message: { role: string; content?: string | null; tool_calls?: OpenAIToolCall[] }
  finish_reason?: string
}

function toOpenAIMessages(msg: Message): OpenAIMessage[] {
  if (msg.role === 'assistant') {
    const text = msg.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
    const toolCalls = msg.content
      .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      .map((b) => ({
        id: b.id,
        type: 'function' as const,
        function: { name: b.name, arguments: JSON.stringify(b.input) },
      }))
    return [
      {
        role: 'assistant',
        content: text ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
    ]
  }

  if (msg.role === 'tool') {
    return msg.content
      .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
      .map((b) => ({ role: 'tool' as const, tool_call_id: b.toolUseId, content: b.content }))
  }

  const text = msg.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
  return [{ role: 'user', content: text }]
}

function fromOpenAIChoice(choice: OpenAIChoice): ContentBlock[] {
  const blocks: ContentBlock[] = []
  if (choice.message.content) blocks.push({ type: 'text', text: choice.message.content })
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: unknown
      try {
        input = JSON.parse(tc.function.arguments)
      } catch {
        input = tc.function.arguments
      }
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
    }
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
  return blocks
}
