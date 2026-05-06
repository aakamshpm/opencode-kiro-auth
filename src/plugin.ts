import { KIRO_CONSTANTS } from './constants.js'
import { AuthHandler } from './core/auth/auth-handler.js'
import { RequestHandler } from './core/request/request-handler.js'
import { AccountCache } from './infrastructure/database/account-cache.js'
import { AccountRepository } from './infrastructure/database/account-repository.js'
import { AccountManager } from './plugin/accounts.js'
import { loadConfig } from './plugin/config/index.js'

type ToastFunction = (message: string, variant: string) => void

const KIRO_PROVIDER_ID = 'kiro'

export const createKiroPlugin =
  (id: string) =>
  async ({ client, directory }: any) => {
    const config = loadConfig(directory)

    const showToast: ToastFunction = (message: string, variant: string) => {
      client.tui.showToast({ body: { message, variant } }).catch(() => {})
    }

    const cache = new AccountCache(60000)
    const repository = new AccountRepository(cache)

    const authHandler = new AuthHandler(config, repository)
    const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy)
    authHandler.setAccountManager(accountManager)

    const requestHandler = new RequestHandler(accountManager, config, repository, client)

    return {
      config: async (input: any) => {
        if (!input.provider) input.provider = {}
        if (!input.provider[id]) input.provider[id] = {}
        input.provider[id].npm = '@ai-sdk/openai-compatible'
      },
      auth: {
        provider: id,
        loader: async (getAuth: any) => {
          await getAuth()
          await authHandler.initialize(showToast as any)

          return {
            apiKey: '',
            baseURL: KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace(
              '{{region}}',
              config.default_region || 'us-east-1'
            ),
            fetch: (input: any, init?: any) => requestHandler.handle(input, init, showToast)
          }
        },
        methods: authHandler.getMethods()
      },
      provider: {
        id,
        models: async (provider: any) => {
          const models = provider?.models || {}
          const normalized: Record<string, any> = {}

          for (const [modelID, model] of Object.entries(models)) {
            const modelInfo = model as any
            normalized[modelID] = {
              ...modelInfo,
              api: {
                ...(modelInfo.api || {}),
                npm: '@ai-sdk/openai-compatible'
              }
            }
          }

          return normalized
        }
      }
    }
  }

export const KiroOAuthPlugin = createKiroPlugin(KIRO_PROVIDER_ID)
