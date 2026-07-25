import { afterEach, describe, expect, test } from 'bun:test'
import {
  formatWebSearchResults,
  kiroWebSearch,
  type WebSearchResult
} from '../plugin/web-search.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('formatWebSearchResults', () => {
  test('returns a friendly message when there are no results', () => {
    expect(formatWebSearchResults([])).toBe('No results found.')
  })

  test('renders title as a markdown link with the URL', () => {
    const results: WebSearchResult[] = [
      { title: 'Servoy', url: 'https://servoy.com', snippet: 'Low-code platform' }
    ]
    const out = formatWebSearchResults(results)
    expect(out).toContain('[Servoy](https://servoy.com)')
    expect(out).toContain('Low-code platform')
  })

  test('includes domain and publish date when present', () => {
    const results: WebSearchResult[] = [
      {
        title: 'Node 24',
        url: 'https://nodejs.org',
        snippet: 'Release',
        domain: 'nodejs.org',
        publishedDate: Date.UTC(2026, 0, 15)
      }
    ]
    const out = formatWebSearchResults(results)
    expect(out).toContain('nodejs.org')
    expect(out).toContain('2026-01-15')
  })

  test('numbers multiple results in order', () => {
    const results: WebSearchResult[] = [
      { title: 'A', url: 'https://a.test', snippet: '' },
      { title: 'B', url: 'https://b.test', snippet: '' }
    ]
    const out = formatWebSearchResults(results)
    expect(out.indexOf('1. [A]')).toBeLessThan(out.indexOf('2. [B]'))
  })

  test('omits the meta line when neither domain nor date is present', () => {
    const results: WebSearchResult[] = [{ title: 'X', url: 'https://x.test', snippet: 'hi' }]
    const out = formatWebSearchResults(results)
    expect(out).toBe('1. [X](https://x.test)\n   hi')
  })
})

describe('kiroWebSearch', () => {
  test('selects a healthy Pro account when a free account appears first', async () => {
    const freeAccount = {
      id: 'free',
      profileArn: undefined,
      isHealthy: true,
      rateLimitResetTime: 0
    }
    const proAccount = {
      id: 'pro',
      profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/pro',
      isHealthy: true,
      rateLimitResetTime: 0
    }
    let selectedAccount: any
    let requestBody: any

    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({ result: { content: [{ type: 'text', text: '{"results":[]}' }] } }),
        { status: 200 }
      )
    }) as unknown as typeof fetch

    const accountManager = {
      getAccounts: () => [freeAccount, proAccount],
      toAuthDetails: (account: any) => {
        selectedAccount = account
        return {
          refresh: 'refresh|desktop',
          access: 'access',
          expires: Date.now() + 3600000,
          authMethod: 'desktop',
          region: 'us-east-1',
          profileArn: account.profileArn
        }
      }
    } as any

    expect(await kiroWebSearch(accountManager, 'latest release')).toEqual([])
    expect(selectedAccount).toBe(proAccount)
    expect(requestBody.profileArn).toBe(proAccount.profileArn)
  })
})
