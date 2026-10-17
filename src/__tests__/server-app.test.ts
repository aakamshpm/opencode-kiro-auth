import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KIRO_API_PATTERN } from '../core/request/request-handler.js'
import { transformSdkStream } from '../plugin/streaming/sdk-stream-transformer.js'
import { aggregateSse, buildKiroUrl, createApp, type ServerDeps } from '../server/app.js'
import { DEFAULT_PORT, readServerEnv } from '../server/env.js'

const KEY = 'test-key'

// The logger writes under XDG_CONFIG_HOME; keep test runs out of the real one.
let xdgDir: string
const originalXdg = process.env.XDG_CONFIG_HOME
beforeAll(() => {
  xdgDir = mkdtempSync(join(tmpdir(), 'kiro-server-test-'))
  process.env.XDG_CONFIG_HOME = xdgDir
})
afterAll(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdg
  rmSync(xdgDir, { recursive: true, force: true })
})

const MODELS = {
  'claude-sonnet-5-5': {
    name: 'Claude Sonnet 5.5 (1.3x)',
    limit: { context: 1000000, output: 64000 }
  },
  'claude-sonnet-5-5-thinking': { name: 'Claude Sonnet 5.5 Thinking (1.3x)' }
}

function sse(...chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')
}

function sseResponse(body: string | ReadableStream<Uint8Array>, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } })
}

interface Harness {
  app: (req: Request) => Promise<Response>
  calls: Array<{ input: string; init: { method: string; body: string } }>
}

const OK_UPSTREAM = async () =>
  sseResponse(sse({ id: 'c1', choices: [{ index: 0, delta: { content: 'ok' } }] }))

function harness(upstream: () => Promise<Response> = OK_UPSTREAM): Harness {
  const calls: Harness['calls'] = []
  const deps: ServerDeps = {
    apiKey: KEY,
    kiroUrl: buildKiroUrl('us-east-1'),
    models: () => MODELS,
    handle: async (input, init) => {
      calls.push({ input, init })
      return upstream()
    }
  }
  return { app: createApp(deps), calls }
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1${path}`, { headers })
}

const chatBody = (extra: Record<string, unknown> = {}) => ({
  model: 'claude-sonnet-5-5',
  messages: [{ role: 'user', content: 'hi' }],
  ...extra
})

describe('server auth and health', () => {
  test('refuses to build an app without an API key', () => {
    expect(() =>
      createApp({ apiKey: '', kiroUrl: '', handle: async () => new Response(), models: () => ({}) })
    ).toThrow()
  })

  test('/health needs no auth', async () => {
    const res = await harness().app(get('/health'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  test('rejects missing and wrong keys with 401', async () => {
    const { app, calls } = harness()
    const missing = await app(get('/v1/models'))
    const wrong = await app(get('/v1/models', { Authorization: 'Bearer nope' }))
    const wrongLen = await app(get('/v1/models', { 'x-api-key': 'x' }))
    for (const res of [missing, wrong, wrongLen]) {
      expect(res.status).toBe(401)
      expect((await res.json()).error.type).toBe('authentication_error')
    }
    const chat = await app(
      post('/v1/chat/completions', chatBody(), { Authorization: 'Bearer nope' })
    )
    expect(chat.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  test('accepts Bearer and x-api-key', async () => {
    const { app } = harness()
    expect((await app(get('/v1/models', { Authorization: `Bearer ${KEY}` }))).status).toBe(200)
    expect((await app(get('/v1/models', { 'x-api-key': KEY }))).status).toBe(200)
  })
})

describe('/v1/models', () => {
  test('lists the registry with names and context length', async () => {
    const res = await harness().app(get('/v1/models', { Authorization: `Bearer ${KEY}` }))
    const body = await res.json()
    expect(body.object).toBe('list')
    expect(body.data.map((m: any) => m.id)).toEqual(Object.keys(MODELS))
    expect(body.data[0]).toMatchObject({
      object: 'model',
      owned_by: 'kiro',
      name: 'Claude Sonnet 5.5 (1.3x)',
      context_length: 1000000
    })
    expect(body.data[1].context_length).toBeUndefined()
  })
})

describe('/v1/chat/completions validation', () => {
  test('unknown route is 404', async () => {
    const res = await harness().app(get('/v1/nope', { 'x-api-key': KEY }))
    expect(res.status).toBe(404)
  })

  test('wrong method on a known route is 404', async () => {
    const res = await harness().app(get('/v1/chat/completions', { 'x-api-key': KEY }))
    expect(res.status).toBe(404)
  })

  test.each([
    ['invalid JSON', '{nope'],
    ['missing model', { messages: [{ role: 'user', content: 'x' }] }],
    ['empty model', { model: '', messages: [{ role: 'user', content: 'x' }] }],
    ['missing messages', { model: 'claude-sonnet-5-5' }],
    ['empty messages', { model: 'claude-sonnet-5-5', messages: [] }],
    ['null body', 'null']
  ])('400 for %s', async (_name, body) => {
    const { app, calls } = harness()
    const res = await app(post('/v1/chat/completions', body))
    expect(res.status).toBe(400)
    expect((await res.json()).error.type).toBe('invalid_request_error')
    expect(calls).toHaveLength(0)
  })

  test.each(['gpt-4o', 'constructor', '__proto__'])('404 for unknown model %s', async (model) => {
    const { app, calls } = harness()
    const res = await app(post('/v1/chat/completions', chatBody({ model })))
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('model_not_found')
    expect(calls).toHaveLength(0)
  })
})

describe('/v1/chat/completions upstream handling', () => {
  test('kiroUrl is one RequestHandler will intercept', () => {
    for (const region of ['us-east-1', 'eu-central-1']) {
      expect(KIRO_API_PATTERN.test(buildKiroUrl(region))).toBe(true)
    }
  })

  test('forwards the raw body to the handler', async () => {
    const { app, calls } = harness()
    const raw = JSON.stringify(chatBody({ stream: true, tools: [{ type: 'function' }] }))
    await app(post('/v1/chat/completions', raw))
    expect(calls).toHaveLength(1)
    expect(KIRO_API_PATTERN.test(calls[0]!.input)).toBe(true)
    expect(calls[0]!.init).toEqual({ method: 'POST', body: raw })
  })

  test('streams chunks through and appends [DONE]', async () => {
    const { app } = harness(async () =>
      sseResponse(
        sse(
          { id: 'c1', choices: [{ index: 0, delta: { content: 'he' } }] },
          { id: 'c1', choices: [{ index: 0, delta: { content: 'llo' } }] },
          { id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
        )
      )
    )
    const res = await app(post('/v1/chat/completions', chatBody({ stream: true })))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const text = await res.text()
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true)
    expect(text.match(/data: \{/g)).toHaveLength(3)
    expect(text.indexOf('"he"')).toBeLessThan(text.indexOf('"llo"'))
  })

  test('reports a mid-stream failure as an in-band error chunk', async () => {
    let sent = false
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(
            new TextEncoder().encode(
              sse({ id: 'c1', choices: [{ index: 0, delta: { content: 'x' } }] })
            )
          )
          return
        }
        throw new Error('Kiro returned an empty response')
      }
    })
    const { app } = harness(async () => sseResponse(failing))
    const res = await app(post('/v1/chat/completions', chatBody({ stream: true })))
    const text = await res.text()
    expect(text).toContain('"content":"x"')
    expect(text).toContain(
      '"error":{"message":"Kiro returned an empty response","type":"api_error"}'
    )
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true)
  })

  test('aggregates to a chat.completion unless stream is true', async () => {
    const upstream = async () =>
      sseResponse(
        sse(
          { id: 'c9', created: 5, choices: [{ index: 0, delta: { content: 'ok' } }] },
          {
            id: 'c9',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 1 }
          }
        )
      )
    for (const extra of [{}, { stream: false }]) {
      const res = await harness(upstream).app(post('/v1/chat/completions', chatBody(extra)))
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        id: 'c9',
        object: 'chat.completion',
        model: 'claude-sonnet-5-5',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1 }
      })
    }
  })

  test('passes upstream error responses through untouched', async () => {
    const contextError = {
      error: {
        message: 'input is too long for requested model',
        type: 'invalid_request_error',
        code: 'context_length_exceeded'
      }
    }
    const { app } = harness(async () => Response.json(contextError, { status: 400 }))
    const res = await app(post('/v1/chat/completions', chatBody({ stream: true })))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(contextError)
  })

  test('maps handler failures: 429 stays 429, others become 502', async () => {
    const rateLimited = harness(async () => {
      throw new Error('Kiro Error: 429')
    })
    const res429 = await rateLimited.app(post('/v1/chat/completions', chatBody()))
    expect(res429.status).toBe(429)

    const broken = harness(async () => {
      throw new Error('All accounts are permanently unhealthy. Please re-authenticate.')
    })
    const res502 = await broken.app(post('/v1/chat/completions', chatBody()))
    expect(res502.status).toBe(502)
    expect((await res502.json()).error.message).toContain('re-authenticate')
  })

  test('non-streaming reports an upstream stream failure as 502', async () => {
    const failing = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('boom')
      }
    })
    const res = await harness(async () => sseResponse(failing)).app(
      post('/v1/chat/completions', chatBody())
    )
    expect(res.status).toBe(502)
  })
})

describe('aggregateSse', () => {
  test('joins text deltas and defaults finish_reason', async () => {
    const out = await aggregateSse(
      sse(
        { id: 'a', choices: [{ delta: { content: 'foo' } }] },
        { choices: [{ delta: { content: 'bar' } }] }
      ) + 'data: [DONE]\n\n',
      'm'
    )
    expect(out.choices[0].message).toEqual({ role: 'assistant', content: 'foobar' })
    expect(out.choices[0].finish_reason).toBe('stop')
    expect(out.id).toBe('a')
    expect(out.usage).toBeUndefined()
  })

  test('keeps reasoning_content separate from content', async () => {
    const out = await aggregateSse(
      sse(
        { choices: [{ delta: { reasoning_content: 'think ' } }] },
        { choices: [{ delta: { reasoning_content: 'hard' } }] },
        { choices: [{ delta: { content: 'answer' } }] }
      ),
      'm'
    )
    expect(out.choices[0].message.reasoning_content).toBe('think hard')
    expect(out.choices[0].message.content).toBe('answer')
  })

  test('reassembles tool_call fragments by index', async () => {
    const call = (index: number, fn: Record<string, string>, id?: string) => ({
      choices: [
        {
          delta: { tool_calls: [{ index, ...(id ? { id, type: 'function' } : {}), function: fn }] }
        }
      ]
    })
    const out = await aggregateSse(
      sse(
        call(1, { name: 'read', arguments: '' }, 'call_b'),
        call(0, { name: 'bash', arguments: '' }, 'call_a'),
        call(0, { arguments: '{"command":' }),
        call(1, { arguments: '{"path":"/x"}' }),
        call(0, { arguments: '"ls"}' }),
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
      ),
      'm'
    )
    const msg = out.choices[0].message
    expect(msg.content).toBeNull()
    expect(msg.tool_calls).toEqual([
      { id: 'call_a', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
      { id: 'call_b', type: 'function', function: { name: 'read', arguments: '{"path":"/x"}' } }
    ])
    expect(out.choices[0].finish_reason).toBe('tool_calls')
  })

  test('infers tool_calls finish_reason and keeps usage', async () => {
    const usage = {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      cache_read_input_tokens: 4
    }
    const out = await aggregateSse(
      sse(
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 't', function: { name: 'x', arguments: '{}' } }]
              }
            }
          ]
        },
        { choices: [], usage }
      ),
      'm'
    )
    expect(out.choices[0].finish_reason).toBe('tool_calls')
    expect(out.usage).toEqual(usage)
  })

  test('ignores malformed and non-data lines', async () => {
    const out = await aggregateSse(
      ': comment\ndata: {bad\n\n' + sse({ choices: [{ delta: { content: 'z' } }] }),
      'm'
    )
    expect(out.choices[0].message.content).toBe('z')
  })
})

describe('end to end with the real stream transformer', () => {
  async function* events(list: any[]) {
    for (const e of list) yield e
  }

  const sdkEvents = () => ({
    generateAssistantResponseResponse: events([
      { reasoningContentEvent: { text: 'plan' } },
      { assistantResponseEvent: { content: 'Running it.' } },
      { toolUseEvent: { toolUseId: 'tu1', name: 'bash', input: '{"command":' } },
      { toolUseEvent: { toolUseId: 'tu1', input: '"ls"}' } },
      { metadataEvent: { tokenUsage: { cacheReadInputTokens: 7, cacheWriteInputTokens: 2 } } }
    ])
  })

  // Same wrapping ResponseHandler.handleSdkStreaming does.
  const upstream = async () =>
    sseResponse(
      new ReadableStream<Uint8Array>({
        async start(c) {
          for await (const chunk of transformSdkStream(sdkEvents(), 'claude-sonnet-5-5', 'conv1')) {
            c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`))
          }
          c.close()
        }
      })
    )

  test('streams text, reasoning and a tool call, ending with [DONE]', async () => {
    const res = await harness(upstream).app(
      post('/v1/chat/completions', chatBody({ stream: true }))
    )
    const text = await res.text()
    expect(text).toContain('"reasoning_content":"plan"')
    expect(text).toContain('"content":"Running it."')
    expect(text).toContain('"name":"bash"')
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true)
  })

  test('aggregates the same stream for stream:false clients', async () => {
    const res = await harness(upstream).app(post('/v1/chat/completions', chatBody()))
    const out = await res.json()
    expect(out.choices[0].message.content).toBe('Running it.')
    expect(out.choices[0].message.reasoning_content).toBe('plan')
    expect(out.choices[0].message.tool_calls).toEqual([
      { id: 'tu1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }
    ])
    expect(out.choices[0].finish_reason).toBe('tool_calls')
    expect(out.usage.cache_read_input_tokens).toBe(7)
    expect(out.usage.cache_creation_input_tokens).toBe(2)
  })
})

describe('readServerEnv', () => {
  test('requires KIRO_AUTH_API_KEY', () => {
    expect(() => readServerEnv({})).toThrow('KIRO_AUTH_API_KEY')
    expect(() => readServerEnv({ KIRO_AUTH_API_KEY: '  ' })).toThrow('KIRO_AUTH_API_KEY')
  })

  test('defaults to loopback on 8001', () => {
    expect(readServerEnv({ KIRO_AUTH_API_KEY: 'k' })).toEqual({
      host: '127.0.0.1',
      port: DEFAULT_PORT,
      apiKey: 'k'
    })
    expect(DEFAULT_PORT).toBe(8001)
  })

  test('honours KIRO_AUTH_PORT and validates it', () => {
    expect(readServerEnv({ KIRO_AUTH_API_KEY: 'k', KIRO_AUTH_PORT: '9000' }).port).toBe(9000)
    for (const bad of ['abc', '0', '70000', '80.5']) {
      expect(() => readServerEnv({ KIRO_AUTH_API_KEY: 'k', KIRO_AUTH_PORT: bad })).toThrow(
        'KIRO_AUTH_PORT'
      )
    }
  })
})
