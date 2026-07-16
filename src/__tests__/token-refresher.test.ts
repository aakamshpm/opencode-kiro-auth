import { afterEach, describe, expect, test } from 'bun:test'
import { TokenRefresher } from '../core/auth/token-refresher.js'
import type { AccountRepository } from '../infrastructure/database/account-repository.js'
import type { AccountManager } from '../plugin/accounts.js'
import type { KiroAuthDetails, ManagedAccount } from '../plugin/types.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('TokenRefresher', () => {
  test('restarts the request loop after persisting refreshed credentials', async () => {
    const account: ManagedAccount = {
      id: 'account-id',
      email: 'user@example.com',
      authMethod: 'idc',
      region: 'us-east-1',
      oidcRegion: 'us-east-1',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'old-refresh',
      accessToken: 'expired-access',
      expiresAt: Date.now() - 1000,
      rateLimitResetTime: 0,
      isHealthy: true,
      failCount: 0
    }
    const auth: KiroAuthDetails = {
      refresh: 'old-refresh|client-id|client-secret|idc',
      access: account.accessToken,
      expires: account.expiresAt,
      authMethod: 'idc',
      region: 'us-east-1',
      oidcRegion: 'us-east-1'
    }
    let persistedAccounts: ManagedAccount[] | undefined

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: 'fresh-access',
          refresh_token: 'fresh-refresh',
          expires_in: 3600
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as unknown as typeof fetch

    const accountManager = {
      updateFromAuth(target: ManagedAccount, refreshed: KiroAuthDetails) {
        target.accessToken = refreshed.access
        target.refreshToken = 'fresh-refresh'
        target.expiresAt = refreshed.expires
      },
      getAccounts: () => [account]
    } as unknown as AccountManager
    const repository = {
      batchSave: async (accounts: ManagedAccount[]) => {
        persistedAccounts = accounts
      }
    } as unknown as AccountRepository
    const refresher = new TokenRefresher(
      {
        token_expiry_buffer_ms: 300000,
        auto_sync_kiro_cli: false,
        account_selection_strategy: 'sticky'
      },
      accountManager,
      async () => {},
      repository
    )

    const result = await refresher.refreshIfNeeded(account, auth, () => {})

    expect(result.shouldContinue).toBe(true)
    expect(account.accessToken).toBe('fresh-access')
    expect(account.refreshToken).toBe('fresh-refresh')
    expect(persistedAccounts).toEqual([account])
  })
})
