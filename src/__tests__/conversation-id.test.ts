import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { deriveConversationId } from '../plugin/request.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('deriveConversationId', () => {
  const original = process.env.KIRO_STABLE_CONVERSATION_ID

  afterEach(() => {
    if (original === undefined) delete process.env.KIRO_STABLE_CONVERSATION_ID
    else process.env.KIRO_STABLE_CONVERSATION_ID = original
  })

  test('is random per request when the flag is off', () => {
    delete process.env.KIRO_STABLE_CONVERSATION_ID
    const msgs = [{ role: 'user', content: 'hi' }]
    const a = deriveConversationId('sys', msgs)
    expect(a).toMatch(UUID)
    expect(deriveConversationId('sys', msgs)).not.toBe(a)
  })

  describe('with KIRO_STABLE_CONVERSATION_ID=1', () => {
    beforeEach(() => {
      process.env.KIRO_STABLE_CONVERSATION_ID = '1'
    })

    test('stays the same as the conversation grows', () => {
      const turn1 = [{ role: 'user', content: 'fix the bug' }]
      const turn3 = [
        ...turn1,
        { role: 'assistant', content: 'done' },
        { role: 'user', content: [{ type: 'text', text: 'now add a test' }] }
      ]
      const a = deriveConversationId('You are a coding agent.', turn1)
      expect(a).toMatch(UUID)
      expect(deriveConversationId('You are a coding agent.', turn3)).toBe(a)
    })

    test('ignores digits that change between turns (dates, git status)', () => {
      const msgs = [{ role: 'user', content: 'fix the bug' }]
      expect(deriveConversationId("Today's date is 2026-10-19. 3 files changed.", msgs)).toBe(
        deriveConversationId("Today's date is 2026-10-20. 5 files changed.", msgs)
      )
    })

    test('ignores system prompt changes past the keyed prefix', () => {
      const msgs = [{ role: 'user', content: 'fix the bug' }]
      const base = 'x'.repeat(2000)
      expect(deriveConversationId(`${base} tail A`, msgs)).toBe(
        deriveConversationId(`${base} tail B`, msgs)
      )
    })

    test('ignores leading system-role messages when picking the first user turn', () => {
      const plain = [{ role: 'user', content: 'fix the bug' }]
      const withSystem = [{ role: 'system', content: 'reminder' }, ...plain]
      expect(deriveConversationId('sys', withSystem)).toBe(deriveConversationId('sys', plain))
    })

    test('differs between sessions', () => {
      const sys = 'You are a coding agent.'
      const a = deriveConversationId(sys, [{ role: 'user', content: 'fix the bug' }])
      expect(deriveConversationId(sys, [{ role: 'user', content: 'write docs' }])).not.toBe(a)
      expect(
        deriveConversationId('You are a reviewer.', [{ role: 'user', content: 'fix the bug' }])
      ).not.toBe(a)
    })
  })
})
