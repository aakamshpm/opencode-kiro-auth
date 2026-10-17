import { timingSafeEqual } from 'node:crypto'
import * as logger from '../plugin/logger.js'

export type ToastVariant = 'info' | 'warning' | 'success' | 'error'
export type ToastFunction = (message: string, variant: ToastVariant) => void

export interface ServerDeps {
  /** Shared secret clients must send as `Authorization: Bearer` or `x-api-key`. */
  apiKey: string
  /** Kiro chat endpoint URL; must match RequestHandler's Kiro URL pattern. */
  kiroUrl: string
  /** RequestHandler.handle bound to its instance. */
  handle: (
    input: string,
    init: { method: string; body: string },
    toast: ToastFunction
  ) => Promise<Response>
  /** Model registry keyed by client-facing model ID. */
  models: () => Record<string, any>
}

/**
 * Placeholder Kiro URL for RequestHandler.handle(), which only intercepts URLs
 * matching KIRO_API_PATTERN. The real endpoint is rebuilt per account inside
 * the handler; the model comes from the request body, not this URL.
 */
export function buildKiroUrl(region: string): string {
  return `https://q.${region}.amazonaws.com/v1/chat/completions`
}

/** In server mode there is no TUI, so plugin toasts become log lines. */
export const logToast: ToastFunction = (message, variant) => {
  if (variant === 'error') logger.error(message)
  else if (variant === 'warning') logger.warn(message)
  else logger.log(message)
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function openAIError(message: string, status: number, type = 'api_error', code?: string): Response {
  return json({ error: { message, type, ...(code ? { code } : {}) } }, status)
}

/** RequestHandler throws `Kiro Error: <status>`; keep rate limits distinguishable. */
function upstreamStatus(message: string): number {
  return /Kiro Error: 429\b/.test(message) ? 429 : 502
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

function extractKey(req: Request): string {
  const auth = req.headers.get('authorization') || ''
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]
  return (bearer || req.headers.get('x-api-key') || '').trim()
}

/**
 * Append the OpenAI `[DONE]` sentinel the upstream converter does not emit.
 * A failure mid-stream (e.g. an empty Kiro response) is reported in-band as an
 * `error` chunk, which OpenAI-compatible clients surface, rather than by
 * tearing down the connection.
 */
function withDoneSentinel(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        } else {
          controller.enqueue(value)
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        logger.error('Stream failed mid-response', e instanceof Error ? e : new Error(message))
        const error = { error: { message, type: 'api_error' } }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(error)}\n\ndata: [DONE]\n\n`))
        controller.close()
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    }
  })
}

/**
 * Fold OpenAI SSE chunks into a single `chat.completion` object, for clients
 * that do not ask for streaming. The request pipeline always streams upstream.
 */
export async function aggregateSse(sse: string, model: string): Promise<any> {
  let id = `chatcmpl-${crypto.randomUUID()}`
  let created = Math.floor(Date.now() / 1000)
  let content = ''
  let reasoning = ''
  let finish: string | null = null
  let usage: any
  const tools = new Map<
    number,
    { id: string; type: 'function'; function: { name: string; arguments: string } }
  >()

  for (const line of sse.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    let chunk: any
    try {
      chunk = JSON.parse(data)
    } catch {
      continue
    }
    if (chunk.id) id = chunk.id
    if (chunk.created) created = chunk.created
    if (chunk.usage) usage = chunk.usage
    for (const choice of chunk.choices || []) {
      const d = choice.delta || {}
      if (d.content) content += d.content
      if (d.reasoning_content) reasoning += d.reasoning_content
      for (const tc of d.tool_calls || []) {
        const idx = tc.index ?? 0
        const cur = tools.get(idx) || {
          id: '',
          type: 'function' as const,
          function: { name: '', arguments: '' }
        }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.function.name += tc.function.name
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments
        tools.set(idx, cur)
      }
      if (choice.finish_reason) finish = choice.finish_reason
    }
  }

  const toolCalls = [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
  const message: any = { role: 'assistant', content: content || null }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length) message.tool_calls = toolCalls

  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      { index: 0, message, finish_reason: finish || (toolCalls.length ? 'tool_calls' : 'stop') }
    ],
    ...(usage ? { usage } : {})
  }
}

async function chatCompletions(req: Request, deps: ServerDeps): Promise<Response> {
  const raw = await req.text()
  let body: any
  try {
    body = JSON.parse(raw)
  } catch {
    return openAIError('Request body must be valid JSON', 400, 'invalid_request_error')
  }
  if (!body || typeof body.model !== 'string' || !body.model) {
    return openAIError('`model` is required', 400, 'invalid_request_error')
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return openAIError('`messages` must be a non-empty array', 400, 'invalid_request_error')
  }
  if (!Object.hasOwn(deps.models(), body.model)) {
    return openAIError(
      `Unknown model '${body.model}'`,
      404,
      'invalid_request_error',
      'model_not_found'
    )
  }

  let upstream: Response
  try {
    upstream = await deps.handle(deps.kiroUrl, { method: 'POST', body: raw }, logToast)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logger.error('Server request failed', e instanceof Error ? e : new Error(message))
    return openAIError(message, upstreamStatus(message))
  }

  if (!upstream.ok || !upstream.body) return upstream

  if (body.stream !== true) {
    try {
      return json(await aggregateSse(await upstream.text(), body.model))
    } catch (e) {
      // Errors raised mid-stream (e.g. empty Kiro responses) surface here.
      return openAIError(e instanceof Error ? e.message : String(e), 502)
    }
  }

  return new Response(withDoneSentinel(upstream.body), {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache'
    }
  })
}

function listModels(deps: ServerDeps): Response {
  const created = Math.floor(Date.now() / 1000)
  const data = Object.entries(deps.models()).map(([id, m]) => ({
    id,
    object: 'model',
    created,
    owned_by: 'kiro',
    ...(m?.name ? { name: m.name } : {}),
    ...(m?.limit?.context ? { context_length: m.limit.context } : {})
  }))
  return json({ object: 'list', data })
}

/** Build the request handler. Kept free of Bun.serve so it is unit-testable. */
export function createApp(deps: ServerDeps): (req: Request) => Promise<Response> {
  if (!deps.apiKey) throw new Error('apiKey is required')

  return async (req: Request) => {
    const { pathname } = new URL(req.url)

    if (pathname === '/health' && req.method === 'GET') return json({ status: 'ok' })

    if (!safeEqual(extractKey(req), deps.apiKey)) {
      return openAIError('Invalid or missing API key', 401, 'authentication_error')
    }

    if (pathname === '/v1/models' && req.method === 'GET') return listModels(deps)
    if (pathname === '/v1/chat/completions' && req.method === 'POST') {
      return chatCompletions(req, deps)
    }
    return openAIError(`No route for ${req.method} ${pathname}`, 404, 'invalid_request_error')
  }
}
