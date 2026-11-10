import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import { execFileSync } from 'node:child_process'
import { KIRO_CONSTANTS } from '../constants.js'
import type { Effort, KiroAuthDetails } from './types'

/**
 * Cache key includes effort to ensure separate clients for different effort levels,
 * since middleware is configured at client creation time.
 */
interface ClientCacheEntry {
  client: CodeWhispererStreamingClient
  token: string
  effort?: Effort
  model?: string
}

const clientCache = new Map<string, ClientCacheEntry>()
const KIRO_CLI_MAX_ATTEMPTS = 3

/**
 * Kiro gates inference on the client's version since 2026-11-09
 * (kirodotdev/Kiro#11335). Mirroring the installed kiro-cli keeps the client
 * above the floor as kiro-cli auto-updates; the constant is the fallback.
 */
let cachedKiroCliVersion: string | undefined
export function kiroCliVersion(): string {
  if (cachedKiroCliVersion) return cachedKiroCliVersion
  try {
    const out = execFileSync(
      process.env.KIRO_CLI_BIN || `${process.env.HOME || ''}/.local/bin/kiro-cli`,
      ['--version'],
      { timeout: 5000, encoding: 'utf8' }
    )
    const match = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(out)
    if (match) cachedKiroCliVersion = match[1]
  } catch {
    // Binary missing or renamed; the constants fallback still clears the floor.
  }
  return cachedKiroCliVersion || KIRO_CONSTANTS.KIRO_CLIENT_VERSION
}

/**
 * Effort field in the shape each model family expects. GPT models reject
 * `output_config` and Claude models reject `reasoning`, so sending the wrong one
 * returns a 400 ValidationException.
 */
export function buildAdditionalModelRequestFields(effort: Effort, model?: string) {
  return model?.startsWith('gpt-') ? { reasoning: { effort } } : { output_config: { effort } }
}

export function createSdkClient(
  auth: KiroAuthDetails,
  region: string,
  effort?: Effort,
  model?: string
): CodeWhispererStreamingClient {
  const cacheKey = `${region}:${auth.email || 'default'}:${model || 'default'}:${effort || 'none'}`
  const cached = clientCache.get(cacheKey)

  if (
    cached &&
    cached.token === auth.access &&
    cached.effort === effort &&
    cached.model === model
  ) {
    return cached.client
  }

  const token = auth.access
  // Inference host. Kiro began rejecting SSO-issued tokens (idc + builder-id /
  // social login) on the AWS-native q.* hosts on 2026-11-09 with
  // "This version of Kiro is no longer supported" (kirodotdev/Kiro#11335), while
  // the branded runtime.<region>.kiro.dev gateway still serves them —
  // live-verified with our idc account on 2026-11-10. Auth types the gateway
  // refuses, if ever introduced, would need KIRO_INFERENCE_HOST=q.<region>.amazonaws.com.
  const host = process.env.KIRO_INFERENCE_HOST || `runtime.${region}.kiro.dev`
  const client = new CodeWhispererStreamingClient({
    region,
    endpoint: `https://${host}`,
    token: () => Promise.resolve({ token }),
    maxAttempts: KIRO_CLI_MAX_ATTEMPTS,
    retryMode: 'standard',
    customUserAgent: [['kiro-cli', kiroCliVersion()]]
  })

  // Add Kiro-specific headers
  client.middlewareStack.add(
    (next: any) => async (args: any) => {
      args.request.headers['x-amzn-kiro-agent-mode'] = 'vibe'
      return next(args)
    },
    { step: 'build', name: 'addKiroHeaders' }
  )

  // Kiro exposes provider-native effort schemas through additionalModelRequestFields.
  if (effort) {
    client.middlewareStack.add(
      (next: any) => async (args: any) => {
        // The SDK serializes input to args.input, we need to modify the body
        // before it's sent. The body is in args.request.body as a string.
        if (args.request?.body) {
          try {
            const body = JSON.parse(args.request.body)
            body.additionalModelRequestFields = buildAdditionalModelRequestFields(effort, model)
            args.request.body = JSON.stringify(body)
          } catch {
            // If body parsing fails, continue without modification
          }
        }
        return next(args)
      },
      { step: 'build', name: 'addEffortConfig', priority: 'high' }
    )
  }

  clientCache.set(cacheKey, { client, token, effort, model })
  return client
}

export function clearSdkClientCache(): void {
  for (const entry of clientCache.values()) {
    entry.client.destroy()
  }
  clientCache.clear()
}
