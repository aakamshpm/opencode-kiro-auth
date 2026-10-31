import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as logger from '../plugin/logger.js'
import { withDoneSentinel } from '../server/app.js'

const tmpHome = mkdtempSync(join(tmpdir(), 'kiro-sentinel-'))
const prevXdg = process.env.XDG_CONFIG_HOME
beforeAll(() => {
  process.env.XDG_CONFIG_HOME = tmpHome
})
afterAll(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = prevXdg
  rmSync(tmpHome, { recursive: true, force: true })
})

const enc = new TextEncoder()
const dec = new TextDecoder()

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return out
    out += dec.decode(value)
  }
}

describe('withDoneSentinel', () => {
  test('appends [DONE] after the upstream chunks', async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"a":1}\n\n'))
        c.close()
      }
    })
    expect(await drain(withDoneSentinel(upstream))).toBe('data: {"a":1}\n\ndata: [DONE]\n\n')
  })

  test('reports an upstream failure in-band and still ends with [DONE]', async () => {
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => {})
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error('boom'))
      }
    })
    const out = await drain(withDoneSentinel(upstream))
    expect(out).toContain('"message":"boom"')
    expect(out.endsWith('data: [DONE]\n\n')).toBe(true)
    errorSpy.mockRestore()
  })

  test('a client cancel while a read is pending is not a stream failure', async () => {
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => {})
    const upstream = new ReadableStream<Uint8Array>({ start() {} })
    const reader = withDoneSentinel(upstream).getReader()
    await new Promise((r) => setTimeout(r, 5))
    await reader.cancel()
    await new Promise((r) => setTimeout(r, 20))
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  test('a client cancel after some data is not a stream failure', async () => {
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => {})
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"a":1}\n\n'))
      }
    })
    const reader = withDoneSentinel(upstream).getReader()
    expect(dec.decode((await reader.read()).value)).toBe('data: {"a":1}\n\n')
    await new Promise((r) => setTimeout(r, 5))
    await reader.cancel()
    await new Promise((r) => setTimeout(r, 20))
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
