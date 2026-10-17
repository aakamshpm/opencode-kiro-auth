export interface ServerEnv {
  host: string
  port: number
  apiKey: string
}

/** The server only ever listens on loopback; there is deliberately no host override. */
export const SERVER_HOST = '127.0.0.1'
export const DEFAULT_PORT = 8001

export function readServerEnv(env: Record<string, string | undefined>): ServerEnv {
  const apiKey = env.KIRO_AUTH_API_KEY?.trim()
  if (!apiKey) throw new Error('KIRO_AUTH_API_KEY is required')

  const rawPort = env.KIRO_AUTH_PORT?.trim()
  const port = rawPort ? Number(rawPort) : DEFAULT_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`KIRO_AUTH_PORT must be an integer between 1 and 65535, got '${rawPort}'`)
  }

  return { host: SERVER_HOST, port, apiKey }
}
