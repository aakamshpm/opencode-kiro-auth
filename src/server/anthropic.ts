import * as logger from '../plugin/logger.js'
import { anthropicErrorType, estimateInputTokens } from '../plugin/streaming/anthropic-sse.js'
import type { ServerDeps } from './app.js'
import { logToast, upstreamStatus } from './app.js'

/** Image blocks cost roughly this many tokens regardless of their base64 size. */
const IMAGE_TOKEN_ESTIMATE = 1500
const DEFAULT_THINKING_BUDGET = 20000

type Models = Record<string, any>

export class AnthropicRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly errorType = anthropicErrorType(status)
  ) {
    super(message)
    this.name = 'AnthropicRequestError'
  }
}

function requestId(): string {
  return `req_${crypto.randomUUID().replace(/-/g, '')}`
}

export function anthropicError(message: string, status: number, errorType?: string): Response {
  const id = requestId()
  return new Response(
    JSON.stringify({
      type: 'error',
      error: { type: errorType ?? anthropicErrorType(status), message },
      request_id: id
    }),
    { status, headers: { 'Content-Type': 'application/json', 'request-id': id } }
  )
}

// ---------------------------------------------------------------------------
// Model ids
// ---------------------------------------------------------------------------

const FAMILY_FALLBACK: Array<[string, string]> = [
  ['haiku', 'claude-haiku-4-5'],
  ['sonnet', 'claude-sonnet-5-5'],
  ['opus', 'claude-opus-5-5']
]

/**
 * Map the model id an Anthropic client sends onto a registry key. Handles the
 * `[1m]` context suffix, dated snapshots (`-20251001`), `-latest` and dotted
 * versions. Unknown `claude-*` ids fall back to their family so a client's
 * background calls (e.g. a small/fast model) keep working.
 */
export function resolveAnthropicModel(id: string, models: Models): string | null {
  const wantsLongContext = /\[1m\]$/i.test(id.trim())
  let base = id
    .trim()
    .replace(/\[[^\]]*\]$/, '')
    .toLowerCase()
    .replace(/\./g, '-')
    .replace(/-(latest|\d{8})$/, '')

  if (wantsLongContext && Object.hasOwn(models, `${base}-1m`)) base = `${base}-1m`
  if (Object.hasOwn(models, base)) return base

  if (base.startsWith('claude-')) {
    const family = FAMILY_FALLBACK.find(([name]) => base.includes(name))
    if (family && Object.hasOwn(models, family[1])) {
      logger.warn(`Unknown Anthropic model '${id}', using ${family[1]}`)
      return family[1]
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Request conversion: Anthropic Messages -> the plugin's internal request body
// ---------------------------------------------------------------------------

function textOf(blocks: unknown): string {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n\n')
}

function isImageBlock(block: any): boolean {
  return block?.type === 'image' && block.source?.type === 'base64' && !!block.source.data
}

/** Flatten a tool_result payload to text; images are returned to be hoisted alongside it. */
function flattenToolResult(content: unknown): { text: string; images: any[] } {
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return { text: '', images: [] }
  const texts: string[] = []
  const images: any[] = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (isImageBlock(block)) images.push(block)
  }
  return { text: texts.join('\n'), images }
}

function convertContentBlocks(content: unknown[]): any[] {
  const out: any[] = []
  for (const block of content as any[]) {
    switch (block?.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text.length > 0) {
          out.push({ type: 'text', text: block.text })
        }
        break
      case 'image':
        if (isImageBlock(block)) out.push(block)
        else out.push({ type: 'text', text: '[image omitted: only base64 images are supported]' })
        break
      case 'thinking':
        if (typeof block.thinking === 'string' && block.thinking) {
          out.push({ type: 'thinking', thinking: block.thinking })
        }
        break
      case 'tool_use':
        out.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} })
        break
      case 'tool_result': {
        const { text, images } = flattenToolResult(block.content)
        out.push({
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: text || '(no output)',
          ...(block.is_error ? { is_error: true } : {})
        })
        out.push(...images)
        break
      }
      case 'document':
        out.push({ type: 'text', text: '[document omitted: documents are not supported]' })
        break
      // redacted_thinking, server tool blocks and unknown types carry nothing we can replay.
    }
  }
  return out
}

export function convertMessages(messages: any[]): any[] {
  return messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : convertContentBlocks(m.content ?? [])
  }))
}

function convertTools(tools: unknown): any[] | undefined {
  if (!Array.isArray(tools)) return undefined
  // Server-side tools (web_search_2025…, computer_…) have a versioned `type` and no schema.
  const custom = tools.filter(
    (t: any) => t?.name && (t.input_schema || !t.type || t.type === 'custom')
  )
  return custom.length > 0 ? custom : undefined
}

export interface InternalRequest {
  /** Body for RequestHandler: OpenAI-ish envelope that tolerates Anthropic content blocks. */
  body: Record<string, unknown>
  /** Model id as the client asked for it, echoed back in responses. */
  requestedModel: string
  stream: boolean
}

export function validateMessagesBody(body: any): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AnthropicRequestError('Request body must be a JSON object')
  }
  if (typeof body.model !== 'string' || !body.model) {
    throw new AnthropicRequestError('model: Field required')
  }
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) {
    throw new AnthropicRequestError('max_tokens: must be a positive integer')
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new AnthropicRequestError('messages: at least one message is required')
  }
  body.messages.forEach((m: any, i: number) => {
    if (m?.role !== 'user' && m?.role !== 'assistant') {
      throw new AnthropicRequestError(`messages.${i}.role: must be 'user' or 'assistant'`)
    }
    if (typeof m.content !== 'string' && !Array.isArray(m.content)) {
      throw new AnthropicRequestError(`messages.${i}.content: must be a string or an array`)
    }
  })
  if (body.stop_sequences !== undefined && !Array.isArray(body.stop_sequences)) {
    throw new AnthropicRequestError('stop_sequences: must be an array of strings')
  }
}

export function toInternalRequest(body: any, models: Models): InternalRequest {
  validateMessagesBody(body)
  const model = resolveAnthropicModel(body.model, models)
  if (!model) throw new AnthropicRequestError(`model: ${body.model}`, 404)

  const internal: Record<string, unknown> = {
    model,
    stream: true,
    max_tokens: body.max_tokens,
    messages: convertMessages(body.messages)
  }
  const system = textOf(body.system)
  if (system) internal.system = system
  const tools = convertTools(body.tools)
  if (tools) internal.tools = tools
  if (body.thinking?.type === 'enabled' || body.thinking?.type === 'adaptive') {
    internal.thinkingConfig = {
      budget_tokens: Number.isInteger(body.thinking.budget_tokens)
        ? body.thinking.budget_tokens
        : DEFAULT_THINKING_BUDGET
    }
  }
  return { body: internal, requestedModel: body.model, stream: body.stream === true }
}

// ---------------------------------------------------------------------------
// Response conversion
// ---------------------------------------------------------------------------

export class AnthropicStreamError extends Error {
  constructor(
    message: string,
    readonly errorType: string
  ) {
    super(message)
    this.name = 'AnthropicStreamError'
  }
}

/** Fold an Anthropic SSE stream into one Message, for clients that did not ask to stream. */
export function aggregateAnthropicSse(sse: string, model: string): any {
  const message: any = {
    id: `msg_${crypto.randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 }
  }
  const blocks = new Map<number, any>()
  const toolJson = new Map<number, string>()

  for (const line of sse.split('\n')) {
    if (!line.startsWith('data:')) continue
    let ev: any
    try {
      ev = JSON.parse(line.slice(5))
    } catch {
      continue
    }
    switch (ev.type) {
      case 'message_start':
        message.id = ev.message.id ?? message.id
        Object.assign(message.usage, ev.message.usage)
        break
      case 'content_block_start':
        blocks.set(ev.index, { ...ev.content_block })
        break
      case 'content_block_delta': {
        const block = blocks.get(ev.index)
        const d = ev.delta
        if (!block) break
        if (d.type === 'text_delta') block.text += d.text
        else if (d.type === 'thinking_delta') block.thinking += d.thinking
        else if (d.type === 'signature_delta') block.signature = d.signature
        else if (d.type === 'input_json_delta') {
          toolJson.set(ev.index, (toolJson.get(ev.index) ?? '') + d.partial_json)
        }
        break
      }
      case 'message_delta':
        message.stop_reason = ev.delta.stop_reason
        message.stop_sequence = ev.delta.stop_sequence ?? null
        Object.assign(message.usage, ev.usage)
        break
      case 'error':
        throw new AnthropicStreamError(
          ev.error?.message ?? 'Upstream stream failed',
          ev.error?.type ?? 'api_error'
        )
    }
  }

  for (const [index, block] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
    if (block.type === 'tool_use') {
      const raw = toolJson.get(index)
      try {
        block.input = raw ? JSON.parse(raw) : {}
      } catch {
        block.input = {}
      }
    }
    message.content.push(block)
  }
  return message
}

/** Rough prompt-size estimate: text and schemas by length, images as a flat cost. */
export function estimatePromptTokens(body: any): number {
  let tokens = estimateInputTokens(textOf(body?.system))
  tokens += estimateInputTokens(body?.tools ?? [])
  const countContent = (content: unknown): number => {
    if (typeof content === 'string') return estimateInputTokens(content)
    if (!Array.isArray(content)) return 0
    let sum = 0
    for (const block of content as any[]) {
      if (block?.type === 'image') sum += IMAGE_TOKEN_ESTIMATE
      else if (block?.type === 'tool_result') sum += countContent(block.content)
      else if (block?.type === 'tool_use') sum += estimateInputTokens(block.input ?? {})
      else sum += estimateInputTokens(block?.text ?? block?.thinking ?? '')
    }
    return sum
  }
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    tokens += countContent(m?.content) + 4
  }
  return tokens
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function readJson(req: Request): Promise<any> {
  try {
    return JSON.parse(await req.text())
  } catch {
    throw new AnthropicRequestError('Request body must be valid JSON')
  }
}

/** Translate whatever Kiro/RequestHandler answered with when it was not a success. */
async function upstreamFailure(upstream: Response, promptTokens: number): Promise<Response> {
  let message = `Kiro Error: ${upstream.status}`
  let code: string | undefined
  try {
    const j: any = await upstream.json()
    message = j?.error?.message ?? j?.message ?? message
    code = j?.error?.code
  } catch {
    // keep the status-derived message
  }
  if (code === 'context_length_exceeded') {
    // Claude Code keys auto-compaction off this exact phrasing.
    return anthropicError(`prompt is too long: ${promptTokens} tokens`, 400)
  }
  return anthropicError(message, upstream.status)
}

export async function handleMessages(req: Request, deps: ServerDeps): Promise<Response> {
  try {
    const parsed = await readJson(req)
    const { body, requestedModel, stream } = toInternalRequest(parsed, deps.models())
    const promptTokens = estimatePromptTokens(parsed)

    let upstream: Response
    try {
      upstream = await deps.handle(
        deps.kiroUrl,
        { method: 'POST', body: JSON.stringify(body) },
        logToast,
        {
          anthropic: {
            model: requestedModel,
            inputTokensEstimate: promptTokens,
            stopSequences: parsed.stop_sequences,
            maxTokens: parsed.max_tokens
          }
        }
      )
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger.error('Server request failed', e instanceof Error ? e : new Error(message))
      return anthropicError(message, upstreamStatus(message))
    }

    if (!upstream.ok || !upstream.body) return upstreamFailure(upstream, promptTokens)

    if (!stream) {
      try {
        const message = aggregateAnthropicSse(await upstream.text(), requestedModel)
        return new Response(JSON.stringify(message), {
          headers: { 'Content-Type': 'application/json', 'request-id': requestId() }
        })
      } catch (e) {
        if (e instanceof AnthropicStreamError) {
          return anthropicError(e.message, upstreamStatus(e.message), e.errorType)
        }
        return anthropicError(e instanceof Error ? e.message : String(e), 502)
      }
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'request-id': requestId()
      }
    })
  } catch (e) {
    if (e instanceof AnthropicRequestError) return anthropicError(e.message, e.status, e.errorType)
    throw e
  }
}

export async function handleCountTokens(req: Request): Promise<Response> {
  try {
    const body = await readJson(req)
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      throw new AnthropicRequestError('messages: at least one message is required')
    }
    return new Response(JSON.stringify({ input_tokens: estimatePromptTokens(body) }), {
      headers: { 'Content-Type': 'application/json', 'request-id': requestId() }
    })
  } catch (e) {
    if (e instanceof AnthropicRequestError) return anthropicError(e.message, e.status, e.errorType)
    throw e
  }
}
