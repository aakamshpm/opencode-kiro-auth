import { createKiroRuntime } from '../bootstrap.js'
import * as logger from '../plugin/logger.js'
import { buildModelRegistry } from '../plugin/model-registry.js'
import { buildKiroUrl, createApp, logToast } from './app.js'
import { readServerEnv } from './env.js'

const SHUTDOWN_GRACE_MS = 10000

async function main(): Promise<void> {
  logger.enableStderrMirror()

  let env
  try {
    env = readServerEnv(process.env)
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }

  const { config, authHandler, requestHandler } = await createKiroRuntime(process.cwd())
  await authHandler.initialize(logToast)

  const models = buildModelRegistry()
  const app = createApp({
    apiKey: env.apiKey,
    kiroUrl: buildKiroUrl(config.default_region || 'us-east-1'),
    handle: (input, init, toast) => requestHandler.handle(input, init, toast),
    models: () => models
  })

  const server = Bun.serve({
    hostname: env.host,
    port: env.port,
    // Thinking models can stay silent for a long time before the first token.
    idleTimeout: 255,
    fetch: app
  })
  logger.log(`kiro-auth server listening on http://${env.host}:${server.port}`)

  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    logger.log(`${signal} received, shutting down`)
    // stop() resolves once in-flight requests finish; cap the wait so a stuck
    // stream cannot block systemd's stop job.
    await Promise.race([server.stop(), new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS))])
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((e) => {
  console.error('kiro-auth server failed to start:', e)
  process.exit(1)
})
