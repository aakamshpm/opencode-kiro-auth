import { Buffer } from 'node:buffer'
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const binaryToBase64Replacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  return value
}

const getLogDir = () => {
  const platform = process.platform
  const base =
    platform === 'win32'
      ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode')
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
  return join(base, 'kiro-logs')
}

// Request/response logs hold full prompts and code, so keep them private and
// bounded. KIRO_LOG_RETENTION_DAYS=0 disables pruning.
const API_LOG_NAME = /^(error_)?\d{4}-\d{2}-\d{2}T[\w-]+Z_(request|response)\.json$/
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000
let lastPruneAt = 0

const retentionMs = (): number => {
  const raw = process.env.KIRO_LOG_RETENTION_DAYS
  const days = raw === undefined || raw === '' ? 7 : Number(raw)
  return Number.isFinite(days) && days > 0 ? days * 24 * 60 * 60 * 1000 : 0
}

/** Delete API log files older than maxAgeMs. Returns the number removed. */
export function pruneApiLogs(dir: string, maxAgeMs: number, now = Date.now()): number {
  if (maxAgeMs <= 0) return 0
  let removed = 0
  try {
    for (const name of readdirSync(dir)) {
      if (!API_LOG_NAME.test(name)) continue
      const path = join(dir, name)
      try {
        if (now - statSync(path).mtimeMs > maxAgeMs) {
          unlinkSync(path)
          removed++
        }
      } catch {}
    }
  } catch {}
  return removed
}

const ensureLogDir = (dir: string) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') return
  if (Date.now() - lastPruneAt < PRUNE_INTERVAL_MS) return
  lastPruneAt = Date.now()
  // mkdir's mode does not change a directory that already exists.
  try {
    chmodSync(dir, 0o700)
  } catch {}
  setImmediate(() => pruneApiLogs(dir, retentionMs()))
}

let mirrorToStderr = false

/** Echo log lines to stderr as well (server mode, so journald captures them). */
export function enableStderrMirror(): void {
  mirrorToStderr = true
}

const writeToFile = (level: string, message: string, ...args: unknown[]) => {
  try {
    const dir = getLogDir()
    ensureLogDir(dir)
    const path = join(dir, 'plugin.log')
    const timestamp = new Date().toISOString()
    const content = `[${timestamp}] ${level}: ${message} ${args
      .map((a) => {
        if (a instanceof Error) {
          return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ''}`
        }
        if (typeof a === 'object') {
          try {
            return JSON.stringify(a)
          } catch {
            return '[Unserializable object]'
          }
        }
        return String(a)
      })
      .join(' ')}\n`
    appendFileSync(path, content, { mode: 0o600 })
    if (mirrorToStderr) process.stderr.write(content)
  } catch (e) {}
}

const writeApiLog = (
  type: 'request' | 'response',
  data: any,
  timestamp: string,
  isError = false
) => {
  try {
    const dir = getLogDir()
    ensureLogDir(dir)
    const prefix = isError ? 'error_' : ''
    const filename = `${prefix}${timestamp}_${type}.json`
    const path = join(dir, filename)
    const content = JSON.stringify(data, binaryToBase64Replacer, 2)
    writeFileSync(path, content, { mode: 0o600 })
  } catch (e) {}
}

export function log(message: string, ...args: unknown[]): void {
  writeToFile('INFO', message, ...args)
}

export function error(message: string, ...args: unknown[]): void {
  writeToFile('ERROR', message, ...args)
}

export function warn(message: string, ...args: unknown[]): void {
  writeToFile('WARN', message, ...args)
}

export function debug(message: string, ...args: unknown[]): void {
  if (process.env.DEBUG) {
    writeToFile('DEBUG', message, ...args)
  }
}

export function logApiRequest(data: any, timestamp: string): void {
  writeApiLog('request', data, timestamp)
}

export function logApiResponse(data: any, timestamp: string): void {
  writeApiLog('response', data, timestamp)
}

export function logApiError(requestData: any, responseData: any, timestamp: string): void {
  writeApiLog('request', requestData, timestamp, true)
  writeApiLog('response', responseData, timestamp, true)
  const errorType = responseData.status ? `HTTP ${responseData.status}` : 'Network Error'
  const email = requestData.email || 'unknown'
  error(`${errorType} on ${email} - See error_${timestamp}_request.json`)
}

export function getTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}
