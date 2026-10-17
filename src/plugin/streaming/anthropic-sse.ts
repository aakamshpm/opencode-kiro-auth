import { createHash } from 'node:crypto'
import { estimateTokens } from '../response.js'
import type { StreamEvent } from './types.js'

export interface AnthropicStreamOptions {
  /** Model id echoed back to the client (what it asked for, not the Kiro id). */
  model: string
  /** Rough prompt size, reported in message_start before real usage is known. */
  inputTokensEstimate?: number
  /** Kiro has no stop-sequence support, so they are enforced on the way out. */
  stopSequences?: string[]
  /** Likewise enforced here, on an estimated token count (text and thinking only). */
  maxTokens?: number
  /** Interval for `ping` events while the upstream is silent. 0 disables. */
  keepAliveMs?: number
}

const CHARS_PER_TOKEN = 4
const DEFAULT_KEEP_ALIVE_MS = 10000

/** Anthropic-style message id derived from the Kiro conversation id. */
export function anthropicMessageId(conversationId: string): string {
  return `msg_${conversationId.replace(/-/g, '')}`
}

export function anthropicErrorType(status: number): string {
  if (status === 400 || status === 413 || status === 422) return 'invalid_request_error'
  if (status === 401) return 'authentication_error'
  if (status === 403) return 'permission_error'
  if (status === 404) return 'not_found_error'
  if (status === 429) return 'rate_limit_error'
  if (status === 529) return 'overloaded_error'
  return 'api_error'
}

export function frameSse(event: { type: string; [key: string]: unknown }): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

/**
 * Turn the transformer's Anthropic-style events into a spec-conformant message
 * stream: message_start first, strictly sequential content blocks that are always
 * closed, thinking signatures, and a final message_delta carrying stop_reason and
 * usage. Stop sequences and max_tokens are applied here because Kiro ignores them.
 */
export async function* anthropicEvents(
  events: AsyncIterable<StreamEvent>,
  id: string,
  opts: AnthropicStreamOptions
): AsyncGenerator<any> {
  const stops = (opts.stopSequences ?? []).filter((s) => s.length > 0)
  const holdBack = stops.length > 0 ? Math.max(...stops.map((s) => s.length)) - 1 : 0
  const charBudget =
    opts.maxTokens !== undefined && opts.maxTokens >= 0
      ? opts.maxTokens * CHARS_PER_TOKEN
      : Infinity

  yield {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: opts.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: opts.inputTokensEstimate ?? 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      }
    }
  }
  yield { type: 'ping' }

  let open: { index: number; type: string; thinking: string; pending: string } | null = null
  let emittedChars = 0
  let limitReason: 'stop_sequence' | 'max_tokens' | null = null
  let matchedStop: string | null = null
  let sawMessageDelta = false

  const closeOpen = (): any[] => {
    if (!open) return []
    const out: any[] = []
    // emitText prepends the held-back tail itself, so only the flush flag is needed.
    if (open.type === 'text' && open.pending) out.push(...emitText('', true))
    if (open.type === 'thinking') {
      out.push({
        type: 'content_block_delta',
        index: open.index,
        delta: {
          type: 'signature_delta',
          signature: createHash('sha256').update(open.thinking).digest('base64')
        }
      })
    }
    out.push({ type: 'content_block_stop', index: open.index })
    open = null
    return out
  }

  const delta = (index: number, d: any) => ({ type: 'content_block_delta', index, delta: d })

  /** Clamp to the remaining token budget; running out ends the message with max_tokens. */
  const clamp = (text: string): string => {
    const room = charBudget - emittedChars
    if (text.length <= room) return text
    limitReason = 'max_tokens'
    matchedStop = null
    return text.slice(0, Math.max(0, room))
  }

  /** Run text through stop-sequence matching and the token budget. */
  const emitText = (text: string, flush = false): any[] => {
    if (!open || limitReason) return []
    let ready = text
    let hit: string | null = null
    if (stops.length > 0) {
      const all = open.pending + text
      let cut = -1
      for (const s of stops) {
        const at = all.indexOf(s)
        if (at !== -1 && (cut === -1 || at < cut)) {
          cut = at
          hit = s
        }
      }
      if (hit !== null) {
        ready = all.slice(0, cut)
        open.pending = ''
      } else {
        ready = all.slice(0, all.length - (flush ? 0 : holdBack))
        open.pending = all.slice(ready.length)
      }
    }
    const out = clamp(ready)
    // Output cut by the budget before reaching the stop sequence is max_tokens, not a stop.
    if (hit !== null && !limitReason) {
      limitReason = 'stop_sequence'
      matchedStop = hit
    }
    emittedChars += out.length
    return out ? [delta(open.index, { type: 'text_delta', text: out })] : []
  }

  const emitThinking = (text: string): any[] => {
    if (!open || limitReason || !text) return []
    const out = clamp(text)
    emittedChars += out.length
    open.thinking += out
    return out ? [delta(open.index, { type: 'thinking_delta', thinking: out })] : []
  }

  /** Close the open block, then end the message. A limit we hit overrides the upstream reason. */
  const finish = (upstreamReason: string, usage: any): any[] => {
    const tail = closeOpen()
    const estimatedOutput = Math.ceil(emittedChars / CHARS_PER_TOKEN)
    return [
      ...tail,
      {
        type: 'message_delta',
        delta: { stop_reason: limitReason ?? upstreamReason, stop_sequence: matchedStop },
        usage: {
          input_tokens: usage?.input_tokens ?? opts.inputTokensEstimate ?? 0,
          output_tokens:
            limitReason === 'max_tokens'
              ? estimatedOutput
              : (usage?.output_tokens ?? estimatedOutput),
          cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0
        }
      },
      { type: 'message_stop' }
    ]
  }

  for await (const ev of events) {
    if (limitReason) break

    if (ev.type === 'content_block_start') {
      for (const out of closeOpen()) yield out
      if (limitReason) break
      const block = ev.content_block ?? {}
      open = { index: ev.index!, type: block.type, thinking: '', pending: '' }
      yield {
        type: 'content_block_start',
        index: ev.index,
        content_block:
          block.type === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : block
      }
    } else if (ev.type === 'content_block_delta' && open && ev.index === open.index) {
      const d = ev.delta
      let out: any[] = []
      if (d.type === 'text_delta') out = emitText(d.text ?? '')
      else if (d.type === 'thinking_delta') out = emitThinking(d.thinking ?? '')
      else out = [ev]
      for (const o of out) yield o
    } else if (ev.type === 'content_block_stop') {
      if (open && ev.index === open.index) for (const out of closeOpen()) yield out
    } else if (ev.type === 'message_delta') {
      sawMessageDelta = true
      for (const out of finish(ev.delta?.stop_reason ?? 'end_turn', ev.usage)) yield out
      return
    }
  }

  if (limitReason) {
    // Cut short deliberately; the upstream's own usage never arrived.
    for (const out of finish('end_turn', undefined)) yield out
    return
  }
  if (!sawMessageDelta) throw new Error('Kiro stream ended without a final message_delta')
}

/**
 * Frame Anthropic events as SSE. While waiting on a silent upstream (thinking
 * models can sit quiet for a long time) a `ping` is emitted so intermediaries
 * and the client's idle watchdog stay satisfied. A failure becomes an
 * in-band `error` event, as Anthropic's API does once streaming has begun.
 */
export function anthropicSseStream(
  events: AsyncGenerator<any>,
  keepAliveMs = DEFAULT_KEEP_ALIVE_MS
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let pending: Promise<IteratorResult<any>> | null = null

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        pending ??= events.next()
        let result: IteratorResult<any> | null = null
        while (!result) {
          if (keepAliveMs <= 0) {
            result = await pending
            break
          }
          let timer: ReturnType<typeof setTimeout> | undefined
          const tick = new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), keepAliveMs)
          })
          result = await Promise.race([pending, tick]).finally(() => clearTimeout(timer))
          if (!result) controller.enqueue(encoder.encode(frameSse({ type: 'ping' })))
        }
        pending = null
        if (result.done) controller.close()
        else controller.enqueue(encoder.encode(frameSse(result.value)))
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        controller.enqueue(
          encoder.encode(frameSse({ type: 'error', error: { type: 'api_error', message } }))
        )
        controller.close()
      }
    },
    async cancel() {
      await events.return(undefined).catch(() => {})
    }
  })
}

/** Rough prompt-size estimate for message_start / count_tokens. */
export function estimateInputTokens(payload: unknown): number {
  return estimateTokens(typeof payload === 'string' ? payload : JSON.stringify(payload ?? ''))
}
