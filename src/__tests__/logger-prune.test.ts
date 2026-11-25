import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneApiLogs } from '../plugin/logger.js'

const DAY = 24 * 60 * 60 * 1000

describe('pruneApiLogs', () => {
  let dir: string
  const now = Date.now()

  const touch = (name: string, ageMs: number) => {
    const path = join(dir, name)
    writeFileSync(path, '{}')
    const t = (now - ageMs) / 1000
    utimesSync(path, t, t)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kiro-prune-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('removes API logs older than the limit and keeps newer ones', () => {
    touch('2026-10-04T07-44-19-675Z_request.json', 10 * DAY)
    touch('2026-10-04T07-44-19-675Z_response.json', 10 * DAY)
    touch('error_2026-10-04T07-44-19-675Z_response.json', 10 * DAY)
    touch('2026-11-25T07-44-19-675Z_request.json', 1 * DAY)

    expect(pruneApiLogs(dir, 7 * DAY, now)).toBe(3)
    expect(existsSync(join(dir, '2026-11-25T07-44-19-675Z_request.json'))).toBe(true)
    expect(existsSync(join(dir, '2026-10-04T07-44-19-675Z_request.json'))).toBe(false)
  })

  test('never touches files that are not API logs', () => {
    touch('plugin.log', 30 * DAY)
    touch('notes.json', 30 * DAY)

    expect(pruneApiLogs(dir, 7 * DAY, now)).toBe(0)
    expect(existsSync(join(dir, 'plugin.log'))).toBe(true)
    expect(existsSync(join(dir, 'notes.json'))).toBe(true)
  })

  test('a limit of zero disables pruning', () => {
    touch('2026-10-04T07-44-19-675Z_request.json', 100 * DAY)
    expect(pruneApiLogs(dir, 0, now)).toBe(0)
    expect(existsSync(join(dir, '2026-10-04T07-44-19-675Z_request.json'))).toBe(true)
  })

  test('a missing directory is not an error', () => {
    expect(pruneApiLogs(join(dir, 'nope'), 7 * DAY, now)).toBe(0)
  })
})
