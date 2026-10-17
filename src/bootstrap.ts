import { AuthHandler } from './core/auth/auth-handler.js'
import { RequestHandler } from './core/request/request-handler.js'
import { AccountCache } from './infrastructure/database/account-cache.js'
import { AccountRepository } from './infrastructure/database/account-repository.js'
import { AccountManager } from './plugin/accounts.js'
import { loadConfig, type KiroConfig } from './plugin/config/index.js'

export interface KiroRuntime {
  config: KiroConfig
  repository: AccountRepository
  authHandler: AuthHandler
  accountManager: AccountManager
  requestHandler: RequestHandler
}

/**
 * Build the object graph shared by the OpenCode plugin and the standalone
 * server. `client` is the OpenCode SDK client; it is only used for interactive
 * re-authentication, so the server passes none.
 */
export async function createKiroRuntime(directory: string, client?: unknown): Promise<KiroRuntime> {
  const config = loadConfig(directory)

  const cache = new AccountCache(60000)
  const repository = new AccountRepository(cache)

  const authHandler = new AuthHandler(config, repository)
  const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy)
  authHandler.setAccountManager(accountManager)

  const requestHandler = new RequestHandler(accountManager, config, repository, client)

  return { config, repository, authHandler, accountManager, requestHandler }
}
