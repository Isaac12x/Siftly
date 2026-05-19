import prisma from '@/lib/db'
import {
  DEFAULT_LOCAL_BASE_URL,
  DEFAULT_LOCAL_MODEL,
  hasConfiguredLocalEndpoint,
  loadLocalEndpointState,
  type LocalEndpoint,
} from '@/lib/local-endpoints'
export { DEFAULT_LOCAL_BASE_URL, DEFAULT_LOCAL_MODEL } from '@/lib/local-endpoints'

export type AIProvider = 'anthropic' | 'openai' | 'minimax' | 'local'
export type AIKeySetting = 'anthropicApiKey' | 'openaiApiKey' | 'minimaxApiKey' | 'localApiKey'
export type AIModelSetting = 'anthropicModel' | 'openaiModel' | 'minimaxModel' | 'localModel'

export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'
export const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini'
export const DEFAULT_MINIMAX_MODEL = 'MiniMax-M2.7'

// Module-level caches — avoids hundreds of DB roundtrips per pipeline run
let _cachedAnthropicModel: string | null = null
let _anthropicModelCacheExpiry = 0

let _cachedProvider: AIProvider | null = null
let _providerCacheExpiry = 0

let _cachedOpenAIModel: string | null = null
let _openAIModelCacheExpiry = 0

let _cachedMiniMaxModel: string | null = null
let _miniMaxModelCacheExpiry = 0

let _cachedLocalModel: string | null = null
let _localModelCacheExpiry = 0

let _cachedLocalBaseUrl: string | null = null
let _localBaseUrlCacheExpiry = 0

let _cachedLocalEndpoint: LocalEndpoint | null = null
let _localEndpointCacheExpiry = 0

const CACHE_TTL = 5 * 60 * 1000

function normalizeProvider(value: string | null | undefined): AIProvider {
  if (value === 'openai' || value === 'minimax' || value === 'local') return value
  return 'anthropic'
}

export function getApiKeySettingKey(provider: AIProvider): AIKeySetting {
  switch (provider) {
    case 'openai':
      return 'openaiApiKey'
    case 'minimax':
      return 'minimaxApiKey'
    case 'local':
      return 'localApiKey'
    default:
      return 'anthropicApiKey'
  }
}

export function getModelSettingKey(provider: AIProvider): AIModelSetting {
  switch (provider) {
    case 'openai':
      return 'openaiModel'
    case 'minimax':
      return 'minimaxModel'
    case 'local':
      return 'localModel'
    default:
      return 'anthropicModel'
  }
}

/**
 * Get the configured Anthropic model from settings (cached for 5 minutes).
 */
export async function getAnthropicModel(): Promise<string> {
  if (_cachedAnthropicModel && Date.now() < _anthropicModelCacheExpiry) return _cachedAnthropicModel
  const setting = await prisma.setting.findUnique({ where: { key: 'anthropicModel' } })
  _cachedAnthropicModel = setting?.value ?? DEFAULT_ANTHROPIC_MODEL
  _anthropicModelCacheExpiry = Date.now() + CACHE_TTL
  return _cachedAnthropicModel
}

/**
 * Get the effective AI provider (cached for 5 minutes).
 * If a local endpoint/model has been explicitly configured, prefer it over
 * remote providers so the full AI pipeline stays on the local runtime.
 */
export async function getProvider(): Promise<AIProvider> {
  if (_cachedProvider && Date.now() < _providerCacheExpiry) return _cachedProvider
  const [setting, localConfigured] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'aiProvider' } }),
    hasConfiguredLocalEndpoint(),
  ])
  const configuredProvider = normalizeProvider(setting?.value)
  _cachedProvider = localConfigured ? 'local' : configuredProvider
  _providerCacheExpiry = Date.now() + CACHE_TTL
  return _cachedProvider
}

/**
 * Get the configured OpenAI model from settings (cached for 5 minutes).
 */
export async function getOpenAIModel(): Promise<string> {
  if (_cachedOpenAIModel && Date.now() < _openAIModelCacheExpiry) return _cachedOpenAIModel
  const setting = await prisma.setting.findUnique({ where: { key: 'openaiModel' } })
  _cachedOpenAIModel = setting?.value ?? DEFAULT_OPENAI_MODEL
  _openAIModelCacheExpiry = Date.now() + CACHE_TTL
  return _cachedOpenAIModel
}

/**
 * Get the configured MiniMax model from settings (cached for 5 minutes).
 */
export async function getMiniMaxModel(): Promise<string> {
  if (_cachedMiniMaxModel && Date.now() < _miniMaxModelCacheExpiry) return _cachedMiniMaxModel
  const setting = await prisma.setting.findUnique({ where: { key: 'minimaxModel' } })
  _cachedMiniMaxModel = setting?.value ?? DEFAULT_MINIMAX_MODEL
  _miniMaxModelCacheExpiry = Date.now() + CACHE_TTL
  return _cachedMiniMaxModel
}

/**
 * Get the configured Local model from settings (cached for 5 minutes).
 */
export async function getLocalModel(): Promise<string> {
  const endpoint = await getLocalEndpoint()
  return endpoint.model.trim()
}

/**
 * Get the configured Local endpoint base URL from settings (cached for 5 minutes).
 */
export async function getLocalBaseUrl(): Promise<string> {
  const endpoint = await getLocalEndpoint()
  return endpoint.baseUrl || DEFAULT_LOCAL_BASE_URL
}

/**
 * Get the active Local endpoint from settings (cached for 5 minutes).
 */
export async function getLocalEndpoint(): Promise<LocalEndpoint> {
  if (_cachedLocalEndpoint && Date.now() < _localEndpointCacheExpiry) return _cachedLocalEndpoint

  const state = await loadLocalEndpointState()
  _cachedLocalEndpoint = state.activeEndpoint
  _localEndpointCacheExpiry = Date.now() + CACHE_TTL
  _cachedLocalModel = state.activeEndpoint.model
  _localModelCacheExpiry = _localEndpointCacheExpiry
  _cachedLocalBaseUrl = state.activeEndpoint.baseUrl
  _localBaseUrlCacheExpiry = _localEndpointCacheExpiry

  return _cachedLocalEndpoint
}

/**
 * Get the model for the currently active provider.
 */
export async function getActiveModel(): Promise<string> {
  const provider = await getProvider()
  switch (provider) {
    case 'openai':
      return getOpenAIModel()
    case 'minimax':
      return getMiniMaxModel()
    case 'local':
      return getLocalModel()
    default:
      return getAnthropicModel()
  }
}

let _cachedWebhookUrl: string | null = null
let _webhookUrlCacheExpiry = 0

/**
 * Get the configured webhook URL from settings (cached for 5 minutes).
 */
export async function getWebhookUrl(): Promise<string | null> {
  if (_cachedWebhookUrl !== null && Date.now() < _webhookUrlCacheExpiry) return _cachedWebhookUrl || null
  const setting = await prisma.setting.findUnique({ where: { key: 'webhookUrl' } })
  _cachedWebhookUrl = setting?.value?.trim() || ''
  _webhookUrlCacheExpiry = Date.now() + CACHE_TTL
  return _cachedWebhookUrl || null
}

/**
 * Clear all settings caches (call after settings are changed).
 */
export function invalidateSettingsCache(): void {
  _cachedAnthropicModel = null
  _anthropicModelCacheExpiry = 0
  _cachedProvider = null
  _providerCacheExpiry = 0
  _cachedOpenAIModel = null
  _openAIModelCacheExpiry = 0
  _cachedMiniMaxModel = null
  _miniMaxModelCacheExpiry = 0
  _cachedLocalModel = null
  _localModelCacheExpiry = 0
  _cachedLocalBaseUrl = null
  _localBaseUrlCacheExpiry = 0
  _cachedLocalEndpoint = null
  _localEndpointCacheExpiry = 0
  _cachedWebhookUrl = null
  _webhookUrlCacheExpiry = 0
}
