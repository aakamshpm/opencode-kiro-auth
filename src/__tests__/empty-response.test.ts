import { describe, expect, test } from 'bun:test'
import { EmptyResponseError } from '../plugin/streaming/empty-response.js'
import { transformSdkStream } from '../plugin/streaming/sdk-stream-transformer.js'
import { transformKiroStream } from '../plugin/streaming/stream-transformer.js'

// Regression test: Kiro intermittently closes a response stream without any
// usable content (seen live on claude-sonnet-5-5-thinking as thinking-then-
// silence, and on claude-opus-5-5 non-thinking as a fully empty turn). The
// transformers must fail loudly instead of emitting a clean `end_turn` stop
// that opencode records as a phantom empty answer.

function sdkStreamOf(events: any[]) {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const event of events) yield event
    })()
  }
}

async function collectSdk(events: any[], model = 'claude-opus-5-5') {
  const chunks: any[] = []
  for await (const chunk of transformSdkStream(sdkStreamOf(events), model, 'conversation-1')) {
    chunks.push(chunk)
  }
  return chunks
}

async function collectLegacy(body: string, model = 'claude-opus-5-5') {
  const chunks: any[] = []
  for await (const chunk of transformKiroStream(new Response(body), model, 'conversation-1')) {
    chunks.push(chunk)
  }
  return chunks
}

function deltas(chunks: any[]) {
  let reasoning = ''
  let text = ''
  let toolCalls = 0
  for (const chunk of chunks) {
    const delta = chunk.choices?.[0]?.delta
    if (delta?.reasoning_content) reasoning += delta.reasoning_content
    if (delta?.content) text += delta.content
    if (delta?.tool_calls) toolCalls += delta.tool_calls.length
  }
  return { reasoning, text, toolCalls }
}

describe('empty response guard', () => {
  test('sdk stream with only metadata throws EmptyResponseError', async () => {
    const events = [{ metadataEvent: { contextUsagePercentage: 4 } }, { meteringEvent: {} }]
    const err = await collectSdk(events).catch((e) => e)
    expect(err).toBeInstanceOf(EmptyResponseError)
    expect(err.message).toMatch(/empty response/)
    expect(err.message).toMatch(/claude-opus-5-5/)
  })

  test('sdk stream with reasoning but no answer reports the early close', async () => {
    const events = [
      { reasoningContentEvent: { text: 'weighing the options' } },
      { metadataEvent: { contextUsagePercentage: 9 } }
    ]
    const err = await collectSdk(events, 'claude-sonnet-5-5-thinking').catch((e) => e)
    expect(err).toBeInstanceOf(EmptyResponseError)
    expect(err.message).toMatch(/no answer followed/)
    expect(err.message).toMatch(/REASONING_EXTRACTION/)
    // The budget/effort theory was disproven: failing turns streamed as
    // little as 170 chars of reasoning, so no such advice should be given.
    expect(err.message).not.toMatch(/budget|effort/)
  })

  test('sdk stream with redacted-only reasoning and no text throws', async () => {
    const events = [
      { reasoningContentEvent: { redactedContent: new Uint8Array([1, 2, 3]) } },
      { metadataEvent: {} }
    ]
    await expect(collectSdk(events)).rejects.toBeInstanceOf(EmptyResponseError)
  })

  test('sdk stream with text resolves normally', async () => {
    const chunks = await collectSdk([{ assistantResponseEvent: { content: 'Answer.' } }])
    expect(deltas(chunks).text).toBe('Answer.')
  })

  test('sdk stream with only tool calls resolves normally (no text needed)', async () => {
    const chunks = await collectSdk([
      { toolUseEvent: { toolUseId: 't1', name: 'read', input: '{"a":1}' } }
    ])
    expect(deltas(chunks).toolCalls).toBeGreaterThan(0)
  })

  test('legacy stream with empty body throws EmptyResponseError', async () => {
    await expect(collectLegacy('')).rejects.toBeInstanceOf(EmptyResponseError)
  })

  test('legacy stream with content resolves normally', async () => {
    const chunks = await collectLegacy('{"content":"Hi"}')
    expect(deltas(chunks).text).toBe('Hi')
  })
})
