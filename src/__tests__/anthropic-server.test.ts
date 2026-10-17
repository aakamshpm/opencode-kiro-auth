import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  anthropicEvents,
  anthropicMessageId,
  anthropicSseStream,
  frameSse
} from '../plugin/streaming/anthropic-sse.js'
import type { StreamEvent } from '../plugin/streaming/types.js'
import {
  aggregateAnthropicSse,
  estimatePromptTokens,
  resolveAnthropicModel,
  toInternalRequest
} from '../server/anthropic.js'
import { buildKiroUrl, createApp, type ServerDeps } from '../server/app.js'

const KEY = 'test-key'

// The logger writes under XDG_CONFIG_HOME; keep test runs out of the real one.
let xdgDir: string
const originalXdg = process.env.XDG_CONFIG_HOME
beforeAll(() => {
  xdgDir = mkdtempSync(join(tmpdir(), 'kiro-anthropic-test-'))
  process.env.XDG_CONFIG_HOME = xdgDir
})
afterAll(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdg
  rmSync(xdgDir, { recursive: true, force: true })
})

const MODELS = {
  'claude-opus-5-5': {},
  'claude-sonnet-5-5': {},
  'claude-sonnet-5-5-1m': {},
  'claude-haiku-4-5': {}
}

async function* gen(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e
}

async function collect(it: AsyncIterable<any>): Promise<any[]> {
  const out: any[] = []
  for await (const e of it) out.push(e)
  return out
}

const start = (index: number, content_block: any): StreamEvent => ({
  type: 'content_block_start',
  index,
  content_block
})
const delta = (index: number, d: any): StreamEvent => ({
  type: 'content_block_delta',
  index,
  delta: d
})
const stop = (index: number): StreamEvent => ({ type: 'content_block_stop', index })
const done = (stop_reason: string, usage: any = { input_tokens: 10, output_tokens: 5 }) => [
  { type: 'message_delta', delta: { stop_reason }, usage } as StreamEvent,
  { type: 'message_stop' } as StreamEvent
]
const textBlock = (index: number, text: string): StreamEvent[] => [
  start(index, { type: 'text', text: '' }),
  delta(index, { type: 'text_delta', text }),
  stop(index)
]
const types = (events: any[]) => events.map((e) => e.type)

describe('resolveAnthropicModel', () => {
  test.each([
    ['claude-sonnet-5-5', 'claude-sonnet-5-5'],
    ['claude-sonnet-5-5[1m]', 'claude-sonnet-5-5-1m'],
    ['claude-opus-5-5[1m]', 'claude-opus-5-5'],
    ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
    ['claude-haiku-4.5', 'claude-haiku-4-5'],
    ['Claude-Sonnet-5-5-latest', 'claude-sonnet-5-5'],
    ['claude-sonnet-9-9', 'claude-sonnet-5-5'],
    ['claude-3-5-haiku-20241022', 'claude-haiku-4-5']
  ])('%s -> %s', (input, expected) => {
    expect(resolveAnthropicModel(input, MODELS)).toBe(expected)
  })

  test('rejects ids that are not Claude family names', () => {
    expect(resolveAnthropicModel('gpt-4o', MODELS)).toBeNull()
    expect(resolveAnthropicModel('__proto__', MODELS)).toBeNull()
  })
})

describe('toInternalRequest', () => {
  const base = (extra: Record<string, unknown> = {}) => ({
    model: 'claude-sonnet-5-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
    ...extra
  })

  test('joins system blocks, drops cache_control, keeps the model id for echoing', () => {
    const { body, requestedModel, stream } = toInternalRequest(
      base({
        model: 'claude-sonnet-5-5[1m]',
        stream: true,
        system: [
          { type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'Be brief.' }
        ]
      }),
      MODELS
    )
    expect(body.system).toBe('You are Claude Code.\n\nBe brief.')
    expect(body.model).toBe('claude-sonnet-5-5-1m')
    expect(requestedModel).toBe('claude-sonnet-5-5[1m]')
    expect(stream).toBe(true)
    expect(JSON.stringify(body)).not.toContain('cache_control')
  })

  test('passes a plain-string system prompt through', () => {
    expect(toInternalRequest(base({ system: 'plain' }), MODELS).body.system).toBe('plain')
  })

  test('converts tool_use and tool_result, keeping is_error and flattening array content', () => {
    const { body } = toInternalRequest(
      base({
        messages: [
          { role: 'user', content: 'run it' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'ok' },
              { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }
            ]
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                is_error: true,
                content: [
                  { type: 'text', text: 'line a' },
                  { type: 'text', text: 'line b' }
                ]
              }
            ]
          }
        ]
      }),
      MODELS
    )
    const msgs = body.messages as any[]
    expect(msgs[1].content[1]).toEqual({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'Bash',
      input: { command: 'ls' }
    })
    expect(msgs[2].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: 'line a\nline b',
      is_error: true
    })
  })

  test('hoists images out of a tool_result and gives empty results a placeholder', () => {
    const image = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }
    }
    const { body } = toInternalRequest(
      base({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: [image] },
              { type: 'tool_result', tool_use_id: 't2', content: '' }
            ]
          }
        ]
      }),
      MODELS
    )
    const content = (body.messages as any[])[0].content
    expect(content[0]).toMatchObject({ type: 'tool_result', content: '(no output)' })
    expect(content[1]).toEqual(image)
    expect(content[2]).toMatchObject({ type: 'tool_result', content: '(no output)' })
  })

  test('maps thinking budget onto thinkingConfig and defaults when absent', () => {
    const withBudget = toInternalRequest(
      base({ thinking: { type: 'enabled', budget_tokens: 8000 } }),
      MODELS
    )
    expect(withBudget.body.thinkingConfig).toEqual({ budget_tokens: 8000 })
    const adaptive = toInternalRequest(base({ thinking: { type: 'adaptive' } }), MODELS)
    expect((adaptive.body.thinkingConfig as any).budget_tokens).toBeGreaterThan(0)
    expect(
      toInternalRequest(base({ thinking: { type: 'disabled' } }), MODELS).body
    ).not.toHaveProperty('thinkingConfig')
  })

  test('keeps custom tools and drops server-side tools; ignores metadata', () => {
    const { body } = toInternalRequest(
      base({
        metadata: { user_id: 'u' },
        tools: [
          { name: 'Read', description: 'read', input_schema: { type: 'object', properties: {} } },
          { type: 'web_search_20250305', name: 'web_search' }
        ]
      }),
      MODELS
    )
    expect((body.tools as any[]).map((t) => t.name)).toEqual(['Read'])
    expect(body).not.toHaveProperty('metadata')
  })

  test.each([
    [{ messages: [] }, 400],
    [{ max_tokens: 0 }, 400],
    [{ model: undefined }, 400],
    [{ messages: [{ role: 'system', content: 'x' }] }, 400],
    [{ model: 'gpt-4o' }, 404]
  ])('rejects %j with %d', (patch, status) => {
    try {
      toInternalRequest(base(patch as any), MODELS)
      throw new Error('should have thrown')
    } catch (e: any) {
      expect(e.status).toBe(status)
    }
  })
})

describe('anthropicEvents (golden sequences)', () => {
  const opts = { model: 'claude-sonnet-5-5' }

  test('text answer: message_start, ping, one text block, message_delta, message_stop', async () => {
    const out = await collect(
      anthropicEvents(gen([...textBlock(0, 'Hello'), ...done('end_turn')]), 'msg_1', opts)
    )
    expect(types(out)).toEqual([
      'message_start',
      'ping',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop'
    ])
    expect(out[0].message).toMatchObject({
      id: 'msg_1',
      model: 'claude-sonnet-5-5',
      role: 'assistant',
      content: [],
      stop_reason: null
    })
    expect(out[3].delta).toEqual({ type: 'text_delta', text: 'Hello' })
    expect(out[5]).toEqual({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      }
    })
  })

  test('propagates cache token usage from the upstream message_delta', async () => {
    const out = await collect(
      anthropicEvents(
        gen([
          ...textBlock(0, 'x'),
          ...done('end_turn', {
            input_tokens: 3,
            output_tokens: 1,
            cache_creation_input_tokens: 700,
            cache_read_input_tokens: 4200
          })
        ]),
        'msg_1',
        opts
      )
    )
    expect(out.find((e) => e.type === 'message_delta').usage).toMatchObject({
      cache_creation_input_tokens: 700,
      cache_read_input_tokens: 4200
    })
  })

  test('thinking block gets a signature before it closes, then text follows at the next index', async () => {
    const out = await collect(
      anthropicEvents(
        gen([
          start(0, { type: 'thinking', thinking: '' }),
          delta(0, { type: 'thinking_delta', thinking: 'hmm ' }),
          delta(0, { type: 'thinking_delta', thinking: 'ok' }),
          stop(0),
          ...textBlock(1, 'Answer'),
          ...done('end_turn')
        ]),
        'msg_1',
        opts
      )
    )
    expect(types(out)).toEqual([
      'message_start',
      'ping',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop'
    ])
    expect(out[2].content_block).toEqual({ type: 'thinking', thinking: '', signature: '' })
    expect(out[5].delta.type).toBe('signature_delta')
    expect(out[5].delta.signature.length).toBeGreaterThan(0)
    expect(out[7].index).toBe(1)
  })

  test('tool_use streams input_json_delta and ends with stop_reason tool_use', async () => {
    const out = await collect(
      anthropicEvents(
        gen([
          start(0, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }),
          delta(0, { type: 'input_json_delta', partial_json: '{"command":' }),
          delta(0, { type: 'input_json_delta', partial_json: '"ls"}' }),
          stop(0),
          ...done('tool_use')
        ]),
        'msg_1',
        opts
      )
    )
    expect(out[2].content_block).toEqual({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'Bash',
      input: {}
    })
    expect(
      out
        .slice(3, 5)
        .map((e) => e.delta.partial_json)
        .join('')
    ).toBe('{"command":"ls"}')
    expect(out.find((e) => e.type === 'message_delta').delta.stop_reason).toBe('tool_use')
  })

  test('closes a block the upstream left open before the final message_delta', async () => {
    const out = await collect(
      anthropicEvents(
        gen([
          start(0, { type: 'text', text: '' }),
          delta(0, { type: 'text_delta', text: 'cut' }),
          ...done('end_turn')
        ]),
        'msg_1',
        opts
      )
    )
    expect(types(out).slice(-3)).toEqual(['content_block_stop', 'message_delta', 'message_stop'])
  })

  test('stop_sequences end the message at the match, even across deltas', async () => {
    const out = await collect(
      anthropicEvents(
        gen([
          start(0, { type: 'text', text: '' }),
          delta(0, { type: 'text_delta', text: 'one two EN' }),
          delta(0, { type: 'text_delta', text: 'D three' }),
          stop(0),
          ...done('end_turn')
        ]),
        'msg_1',
        { ...opts, stopSequences: ['END'] }
      )
    )
    const text = out
      .filter((e) => e.type === 'content_block_delta')
      .map((e) => e.delta.text)
      .join('')
    expect(text).toBe('one two ')
    expect(out.find((e) => e.type === 'message_delta').delta).toEqual({
      stop_reason: 'stop_sequence',
      stop_sequence: 'END'
    })
    expect(types(out).at(-1)).toBe('message_stop')
  })

  test('held-back text is flushed when no stop sequence ever matches', async () => {
    const out = await collect(
      anthropicEvents(gen([...textBlock(0, 'plain text'), ...done('end_turn')]), 'msg_1', {
        ...opts,
        stopSequences: ['NEVER']
      })
    )
    const text = out
      .filter((e) => e.type === 'content_block_delta')
      .map((e) => e.delta.text)
      .join('')
    expect(text).toBe('plain text')
    expect(out.find((e) => e.type === 'message_delta').delta.stop_reason).toBe('end_turn')
  })

  test('max_tokens truncates output and reports stop_reason max_tokens', async () => {
    const out = await collect(
      anthropicEvents(gen([...textBlock(0, 'x'.repeat(100)), ...done('end_turn')]), 'msg_1', {
        ...opts,
        maxTokens: 5
      })
    )
    const text = out
      .filter((e) => e.type === 'content_block_delta')
      .map((e) => e.delta.text)
      .join('')
    expect(text.length).toBe(20)
    const md = out.find((e) => e.type === 'message_delta')
    expect(md.delta.stop_reason).toBe('max_tokens')
    expect(md.usage.output_tokens).toBe(5)
    expect(types(out).at(-1)).toBe('message_stop')
  })

  test('throws if the upstream ends without a final message_delta', async () => {
    await expect(collect(anthropicEvents(gen(textBlock(0, 'hi')), 'msg_1', opts))).rejects.toThrow(
      /message_delta/
    )
  })
})

describe('anthropicSseStream', () => {
  async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
    return await new Response(stream).text()
  }

  test('frames each event as `event:`/`data:` pairs', async () => {
    const text = await readAll(
      anthropicSseStream(
        anthropicEvents(gen([...textBlock(0, 'a'), ...done('end_turn')]), 'msg_1', { model: 'm' }),
        0
      )
    )
    expect(text.startsWith('event: message_start\ndata: {"type":"message_start"')).toBe(true)
    expect(text.endsWith(`${frameSse({ type: 'message_stop' })}`)).toBe(true)
    expect(text.match(/^event: /gm)?.length).toBe(7)
  })

  test('turns an upstream failure into an in-band error event', async () => {
    async function* failing(): AsyncGenerator<any> {
      yield { type: 'message_start', message: {} }
      throw new Error('boom')
    }
    const text = await readAll(anthropicSseStream(failing(), 0))
    expect(text).toContain('event: error')
    expect(text).toContain('"message":"boom"')
  })

  test('emits ping events while the upstream is silent', async () => {
    async function* slow(): AsyncGenerator<any> {
      await new Promise((r) => setTimeout(r, 60))
      yield { type: 'message_stop' }
    }
    const text = await readAll(anthropicSseStream(slow(), 10))
    expect(text.match(/event: ping/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(text).toContain('event: message_stop')
  })
})

describe('aggregateAnthropicSse', () => {
  test('folds text, thinking, tool_use and usage into a Message', async () => {
    const events = await collect(
      anthropicEvents(
        gen([
          start(0, { type: 'thinking', thinking: '' }),
          delta(0, { type: 'thinking_delta', thinking: 'think' }),
          stop(0),
          ...textBlock(1, 'hello'),
          start(2, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }),
          delta(2, { type: 'input_json_delta', partial_json: '{"path":' }),
          delta(2, { type: 'input_json_delta', partial_json: '"a"}' }),
          stop(2),
          ...done('tool_use', { input_tokens: 7, output_tokens: 9, cache_read_input_tokens: 100 })
        ]),
        'msg_9',
        { model: 'claude-sonnet-5-5' }
      )
    )
    const message = aggregateAnthropicSse(events.map(frameSse).join(''), 'claude-sonnet-5-5')
    expect(message).toMatchObject({
      id: 'msg_9',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      stop_reason: 'tool_use',
      usage: { input_tokens: 7, output_tokens: 9, cache_read_input_tokens: 100 }
    })
    expect(message.content.map((b: any) => b.type)).toEqual(['thinking', 'text', 'tool_use'])
    expect(message.content[0].thinking).toBe('think')
    expect(message.content[0].signature).toBeTruthy()
    expect(message.content[1].text).toBe('hello')
    expect(message.content[2].input).toEqual({ path: 'a' })
  })

  test('surfaces an in-band error event as a thrown error', () => {
    const sse = frameSse({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } })
    expect(() => aggregateAnthropicSse(sse, 'm')).toThrow('busy')
  })
})

describe('estimatePromptTokens', () => {
  test('grows with content and counts images as a flat cost', () => {
    const small = estimatePromptTokens({ messages: [{ role: 'user', content: 'hi' }] })
    const big = estimatePromptTokens({ messages: [{ role: 'user', content: 'hi '.repeat(500) }] })
    const withImage = estimatePromptTokens({
      messages: [{ role: 'user', content: [{ type: 'image', source: { data: 'x'.repeat(10) } }] }]
    })
    expect(big).toBeGreaterThan(small)
    expect(withImage).toBeGreaterThanOrEqual(1500)
  })
})

describe('Anthropic routes', () => {
  const messagesBody = (extra: Record<string, unknown> = {}) => ({
    model: 'claude-sonnet-5-5',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hi' }],
    ...extra
  })

  function harness(
    upstream: (input: string, init: any, options: any) => Promise<Response> = async (_i, _n, o) =>
      new Response(
        anthropicSseStream(
          anthropicEvents(
            gen([...textBlock(0, 'pong'), ...done('end_turn')]),
            'msg_t',
            o.anthropic
          ),
          0
        ),
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
  ) {
    const calls: Array<{ input: string; body: any; options: any }> = []
    const deps: ServerDeps = {
      apiKey: KEY,
      kiroUrl: buildKiroUrl('us-east-1'),
      models: () => MODELS,
      handle: async (input, init, _toast, options) => {
        calls.push({ input, body: JSON.parse(init.body), options })
        return upstream(input, init, options)
      }
    }
    return { app: createApp(deps), calls }
  }

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(`http://127.0.0.1${path}`, {
      method: 'POST',
      headers: {
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219',
        'Content-Type': 'application/json',
        ...headers
      },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })

  test('401 uses the Anthropic error envelope and never reaches upstream', async () => {
    const { app, calls } = harness()
    const res = await app(post('/v1/messages', messagesBody(), { 'x-api-key': 'nope' }))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.type).toBe('error')
    expect(json.error.type).toBe('authentication_error')
    expect(calls).toHaveLength(0)
  })

  test('streams SSE through and hands the handler the Anthropic options', async () => {
    const { app, calls } = harness()
    const res = await app(
      post('/v1/messages?beta=true', messagesBody({ stream: true, stop_sequences: ['X'] }))
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('event: message_start')
    expect(text).toContain('"text":"pong"')
    expect(text).toContain('event: message_stop')
    expect(calls[0]?.options.anthropic).toMatchObject({
      model: 'claude-sonnet-5-5',
      maxTokens: 256,
      stopSequences: ['X']
    })
    expect(calls[0]?.body.model).toBe('claude-sonnet-5-5')
  })

  test('stream:false returns a Message object', async () => {
    const { app } = harness()
    const res = await app(post('/v1/messages', messagesBody()))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const message = await res.json()
    expect(message).toMatchObject({
      id: 'msg_t',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'pong' }],
      stop_reason: 'end_turn'
    })
  })

  test('validation and unknown models use Anthropic error types', async () => {
    const { app, calls } = harness()
    const bad = await app(post('/v1/messages', messagesBody({ messages: [] })))
    expect(bad.status).toBe(400)
    expect((await bad.json()).error.type).toBe('invalid_request_error')
    const notJson = await app(post('/v1/messages', '{nope'))
    expect(notJson.status).toBe(400)
    const unknown = await app(post('/v1/messages', messagesBody({ model: 'gpt-4o' })))
    expect(unknown.status).toBe(404)
    expect((await unknown.json()).error.type).toBe('not_found_error')
    expect(calls).toHaveLength(0)
  })

  test('upstream errors keep their status in the Anthropic envelope', async () => {
    const { app } = harness(
      async () =>
        new Response(JSON.stringify({ error: { message: 'slow down' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        })
    )
    const res = await app(post('/v1/messages', messagesBody()))
    expect(res.status).toBe(429)
    const json = await res.json()
    expect(json.error).toEqual({ type: 'rate_limit_error', message: 'slow down' })
  })

  test('a thrown handler error becomes a 502, or 429 for rate limits', async () => {
    const generic = harness(async () => {
      throw new Error('socket hang up')
    })
    expect((await generic.app(post('/v1/messages', messagesBody()))).status).toBe(502)
    const limited = harness(async () => {
      throw new Error('Kiro Error: 429 Too Many Requests')
    })
    expect((await limited.app(post('/v1/messages', messagesBody()))).status).toBe(429)
  })

  test('context overflow is reported with the phrasing Claude Code compacts on', async () => {
    const { app } = harness(
      async () =>
        new Response(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'x' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        })
    )
    const res = await app(post('/v1/messages', messagesBody()))
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toMatch(/^prompt is too long: \d+ tokens$/)
  })

  test('count_tokens returns an estimate without calling upstream', async () => {
    const { app, calls } = harness()
    const res = await app(
      post('/v1/messages/count_tokens?beta=true', {
        model: 'claude-sonnet-5-5',
        system: 'sys',
        messages: [{ role: 'user', content: 'count me' }]
      })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).input_tokens).toBeGreaterThan(0)
    expect(calls).toHaveLength(0)
    const bad = await app(post('/v1/messages/count_tokens', { model: 'm' }))
    expect(bad.status).toBe(400)
  })

  test('unknown /v1/messages/* paths 404 in the Anthropic shape', async () => {
    const { app } = harness()
    const res = await app(post('/v1/messages/batches', {}))
    expect(res.status).toBe(404)
    expect((await res.json()).type).toBe('error')
  })

  test('message ids derive from the conversation id', () => {
    expect(anthropicMessageId('abc-123')).toBe('msg_abc123')
  })
})
