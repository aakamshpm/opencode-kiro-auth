// Diagnostic: replay a captured full conversationState (dumped via
// KIRO_DUMP_RAW_REQUESTS) directly through the CodeWhisperer SDK and print
// the raw event sequence, bypassing the plugin's own stream transformer.
// This tells us definitively whether an empty response is a server-side
// (CodeWhisperer) event or something introduced by the plugin's parsing.
//
// Usage: node scripts/replay-dump.mjs <path-to-full-dump.json> [repeatCount]

import { CodeWhispererStreamingClient, GenerateAssistantResponseCommand } from '@aws/codewhisperer-streaming-client'
import Database from 'libsql'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const USER_AGENT = 'KiroIDE'

const dumpPath = process.argv[2]
const repeat = parseInt(process.argv[3] || '1', 10)
if (!dumpPath) {
  console.error('usage: node scripts/replay-dump.mjs <full-dump.json> [repeatCount]')
  process.exit(1)
}

const dbPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode', 'kiro.db')
const db = new Database(dbPath, { readonly: true })
const account = db.prepare('select * from accounts where is_healthy = 1 limit 1').get()
if (!account) {
  console.error('no healthy account found in', dbPath)
  process.exit(1)
}

const dump = JSON.parse(readFileSync(dumpPath, 'utf8'))
const region = dump.region || account.region || 'us-east-1'

const client = new CodeWhispererStreamingClient({
  region,
  endpoint: `https://q.${region}.amazonaws.com`,
  token: () => Promise.resolve({ token: account.access_token }),
  maxAttempts: 1,
  retryMode: 'standard',
  customUserAgent: [[USER_AGENT]]
})

client.middlewareStack.add(
  (next) => async (args) => {
    args.request.headers['x-amzn-kiro-agent-mode'] = 'vibe'
    return next(args)
  },
  { step: 'build', name: 'addKiroHeaders' }
)

if (dump.effort) {
  const field = dump.model?.startsWith('gpt-')
    ? { reasoning: { effort: dump.effort } }
    : { output_config: { effort: dump.effort } }
  client.middlewareStack.add(
    (next) => async (args) => {
      if (args.request?.body) {
        try {
          const b = JSON.parse(args.request.body)
          b.additionalModelRequestFields = field
          args.request.body = JSON.stringify(b)
        } catch {
          // ignore
        }
      }
      return next(args)
    },
    { step: 'build', name: 'addEffortConfig', priority: 'high' }
  )
}

async function runOnce(attempt) {
  const command = new GenerateAssistantResponseCommand({
    conversationState: dump.conversationState,
    profileArn: dump.profileArn
  })

  const started = Date.now()
  console.log(`\n=== attempt ${attempt} (model: ${dump.model}, histLen: ${dump.conversationState?.history?.length ?? 0}) ===`)

  let response
  try {
    response = await client.send(command)
  } catch (e) {
    console.log(`  SEND ERROR after ${Date.now() - started}ms:`, e?.message || e)
    return { empty: false, error: true }
  }

  const stream = response.generateAssistantResponseResponse
  if (!stream) {
    console.log('  NO EVENT STREAM on response object. keys:', Object.keys(response))
    return { empty: true, error: false }
  }

  let eventCount = 0
  let textChars = 0
  let reasoningChars = 0
  let toolUseSeen = false
  let eventTypes = []
  let metadataSeen = null

  try {
    for await (const event of stream) {
      eventCount++
      const type = Object.keys(event)[0]
      eventTypes.push(type)
      if (event.assistantResponseEvent?.content) {
        textChars += event.assistantResponseEvent.content.length
      }
      if (event.reasoningContentEvent?.text) {
        reasoningChars += event.reasoningContentEvent.text.length
      }
      if (event.toolUseEvent) {
        toolUseSeen = true
      }
      if (event.metadataEvent) {
        metadataSeen = event.metadataEvent
      }
    }
  } catch (e) {
    console.log(`  STREAM ITERATION ERROR after ${eventCount} events, ${Date.now() - started}ms:`, e?.message || e)
    return { empty: false, error: true }
  }

  const elapsed = Date.now() - started
  console.log(`  done in ${elapsed}ms`)
  console.log(`  total events: ${eventCount}`)
  console.log(`  event type sequence (collapsed):`, summarizeTypes(eventTypes))
  console.log(`  textChars: ${textChars}, reasoningChars: ${reasoningChars}, toolUseSeen: ${toolUseSeen}`)
  console.log(`  metadataEvent:`, metadataSeen ? JSON.stringify(metadataSeen) : null)

  const isEmpty = textChars === 0 && !toolUseSeen
  if (eventCount === 0) {
    console.log('  >>> ZERO EVENTS — confirmed server-side empty stream')
  } else if (isEmpty) {
    console.log('  >>> EVENTS RECEIVED BUT NO TEXT/TOOL CONTENT (reasoning-only or metadata-only)')
  }
  return { empty: isEmpty || eventCount === 0, error: false, elapsed, reasoningChars, textChars }
}

function summarizeTypes(types) {
  const out = []
  for (const t of types) {
    if (out.length && out[out.length - 1].type === t) out[out.length - 1].count++
    else out.push({ type: t, count: 1 })
  }
  return out.map((o) => `${o.type}x${o.count}`).join(' -> ')
}

const results = []
for (let i = 1; i <= repeat; i++) {
  results.push(await runOnce(i))
}

const emptyCount = results.filter((r) => r.empty).length
console.log(`\n=== summary: ${emptyCount}/${repeat} attempts produced an empty response ===`)

client.destroy()
db.close()
