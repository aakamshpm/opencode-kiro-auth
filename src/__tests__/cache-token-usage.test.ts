import { describe, expect, test } from 'bun:test'
import { ResponseHandler } from '../core/request/response-handler.js'
import { transformSdkStream } from '../plugin/streaming/sdk-stream-transformer.js'

// Regression test for the fix ported from upstream PR #129
// (https://github.com/tickernelz/opencode-kiro-auth/pull/129): the SDK
// paths hardcoded cache_creation_input_tokens / cache_read_input_tokens
// to 0 even though CodeWhisperer's TokenUsage carries real
// cacheReadInputTokens / cacheWriteInputTokens. The non-streaming path
// also read a field TokenUsage does not have (`inputTokens`, should be
// `uncachedInputTokens`), so prompt_tokens was always 0 there too.

function sdkStreamOf(events: any[]) {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const event of events) yield event
    })()
  }
}

async function collectUsage(events: any[], model = 'claude-opus-5-5') {
  let usage: any = null
  for await (const chunk of transformSdkStream(sdkStreamOf(events), model, 'conversation-1')) {
    if (chunk.usage) usage = chunk.usage
  }
  return usage
}

describe('cache token usage (SDK streaming)', () => {
  test('propagates non-zero cache fields from metadataEvent.tokenUsage', async () => {
    const usage = await collectUsage([
      { assistantResponseEvent: { content: 'Answer.' } },
      {
        metadataEvent: {
          tokenUsage: {
            uncachedInputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            cacheReadInputTokens: 800,
            cacheWriteInputTokens: 1200
          }
        }
      }
    ])
    expect(usage.cache_read_input_tokens).toBe(800)
    expect(usage.cache_creation_input_tokens).toBe(1200)
  })

  test('defaults to 0 when tokenUsage omits cache fields', async () => {
    const usage = await collectUsage([
      { assistantResponseEvent: { content: 'Answer.' } },
      { metadataEvent: { tokenUsage: { uncachedInputTokens: 10, outputTokens: 5 } } }
    ])
    expect(usage.cache_read_input_tokens).toBe(0)
    expect(usage.cache_creation_input_tokens).toBe(0)
  })

  test('defaults to 0 when metadataEvent has no tokenUsage at all', async () => {
    const usage = await collectUsage([
      { assistantResponseEvent: { content: 'Answer.' } },
      { metadataEvent: { contextUsagePercentage: 5 } }
    ])
    expect(usage.cache_read_input_tokens).toBe(0)
    expect(usage.cache_creation_input_tokens).toBe(0)
  })

  test('defaults to 0 when no metadataEvent ever arrives', async () => {
    const usage = await collectUsage([{ assistantResponseEvent: { content: 'Answer.' } }])
    expect(usage.cache_read_input_tokens).toBe(0)
    expect(usage.cache_creation_input_tokens).toBe(0)
  })
})

describe('cache token usage (SDK non-streaming)', () => {
  const handler = new ResponseHandler()

  function sdkResponseOf(events: any[]) {
    return {
      generateAssistantResponseResponse: (async function* () {
        for (const event of events) yield event
      })()
    }
  }

  async function usageOf(events: any[]) {
    const res = await handler.handleSdkSuccess(
      sdkResponseOf(events),
      'claude-opus-5-5',
      'c1',
      false
    )
    const body = await res.json()
    return body.usage
  }

  test('reads uncachedInputTokens (not the nonexistent inputTokens field) and cache counts', async () => {
    const usage = await usageOf([
      { assistantResponseEvent: { content: 'Answer.' } },
      {
        metadataEvent: {
          tokenUsage: {
            uncachedInputTokens: 55,
            outputTokens: 12,
            cacheReadInputTokens: 300,
            cacheWriteInputTokens: 400
          }
        }
      }
    ])
    expect(usage.prompt_tokens).toBe(55)
    expect(usage.completion_tokens).toBe(12)
    expect(usage.cache_read_input_tokens).toBe(300)
    expect(usage.cache_creation_input_tokens).toBe(400)
  })

  test('defaults to 0 when tokenUsage omits fields', async () => {
    const usage = await usageOf([
      { assistantResponseEvent: { content: 'Answer.' } },
      { metadataEvent: { tokenUsage: {} } }
    ])
    expect(usage.prompt_tokens).toBe(0)
    expect(usage.cache_read_input_tokens).toBe(0)
    expect(usage.cache_creation_input_tokens).toBe(0)
  })

  test('defaults to 0 when no metadataEvent ever arrives', async () => {
    const usage = await usageOf([{ assistantResponseEvent: { content: 'Answer.' } }])
    expect(usage.prompt_tokens).toBe(0)
    expect(usage.cache_read_input_tokens).toBe(0)
    expect(usage.cache_creation_input_tokens).toBe(0)
  })
})

describe('cache token usage (raw HTTP streaming — deliberately unsupported)', () => {
  test('pins the current zero behavior: this wire format cannot carry cache tokens', async () => {
    const { transformKiroStream } = await import('../plugin/streaming/stream-transformer.js')
    const body = '{"content":"Hi"}'
    let usage: any = null
    for await (const chunk of transformKiroStream(
      new Response(body),
      'claude-opus-5-5',
      'conversation-1'
    )) {
      if (chunk.usage) usage = chunk.usage
    }
    expect(usage.cache_read_input_tokens).toBe(0)
    expect(usage.cache_creation_input_tokens).toBe(0)
  })
})
