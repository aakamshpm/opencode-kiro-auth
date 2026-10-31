import { describe, expect, test } from 'bun:test'
import { buildHistory } from '../infrastructure/transformers/history-builder.js'

const model = 'claude-opus-5.5'

describe('buildHistory empty user turns', () => {
  test('gives a placeholder to a history user turn with no text, results or images', () => {
    const history = buildHistory(
      [
        { role: 'user', content: 'start' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: [{ type: 'text', text: '' }] },
        { role: 'assistant', content: 'done' },
        { role: 'user', content: 'next' }
      ],
      model
    )
    const users = history.filter((h) => h.userInputMessage)
    expect(users.length).toBe(2)
    for (const u of users) expect(u.userInputMessage!.content.length).toBeGreaterThan(0)
  })

  test('leaves user turns that carry tool results untouched', () => {
    const history = buildHistory(
      [
        { role: 'user', content: 'run it' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'bash', input: {} }]
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'out' }]
        },
        { role: 'user', content: 'next' }
      ],
      model
    )
    const withResults = history.find(
      (h) => h.userInputMessage?.userInputMessageContext?.toolResults
    )
    expect(withResults?.userInputMessage?.content).toBe('')
  })
})
