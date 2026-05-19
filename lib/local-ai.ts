export type LocalModelSource =
  | 'openai-compatible'
  | 'runtime-active'
  | 'runtime-catalog'

export interface LocalModelOption {
  id: string
  label: string
  source: LocalModelSource
  loaded: boolean
}

export interface LocalChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | LocalChatContentPart[]
}

export type LocalChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface LocalChatCompletionResult {
  text: string
  model: string | null
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

function normalizeCompatiblePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '') || '/'
  const stripped = trimmed
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/models$/i, '')

  if (!stripped || stripped === '/') return '/v1'
  return stripped
}

export function normalizeLocalBaseUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.pathname = normalizeCompatiblePath(url.pathname)
    url.search = ''
    url.hash = ''
    return trimTrailingSlashes(url.toString())
  } catch {
    return null
  }
}

function getOllamaRootUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1$/i, '')
}

function buildUrl(baseUrl: string, path: string): string {
  return `${trimTrailingSlashes(baseUrl)}${path}`
}

function extractModelId(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const id = [item.id, item.model, item.name, item.slug]
    .find((value) => typeof value === 'string' && value.trim()) as string | undefined
  return id?.trim() || null
}

function parseOpenAIModels(payload: unknown): LocalModelOption[] {
  const data = Array.isArray((payload as { data?: unknown })?.data)
    ? (payload as { data: unknown[] }).data
    : Array.isArray(payload)
      ? payload
      : []

  return data
    .map((item) => extractModelId(item))
    .filter((id): id is string => Boolean(id))
    .map((id) => ({
      id,
      label: id,
      source: 'openai-compatible' as const,
      loaded: true,
    }))
}

function parseRuntimeModels(payload: unknown, source: 'runtime-active' | 'runtime-catalog'): LocalModelOption[] {
  const items = Array.isArray((payload as { models?: unknown })?.models)
    ? (payload as { models: unknown[] }).models
    : []

  return items
    .map((item) => extractModelId(item))
    .filter((id): id is string => Boolean(id))
    .map((id) => ({
      id,
      label: id,
      source,
      loaded: source === 'runtime-active',
    }))
}

async function fetchJson(url: string, apiKey?: string): Promise<unknown> {
  const headers: HeadersInit = { Accept: 'application/json' }
  if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(4_000),
    cache: 'no-store',
  })

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }

  return response.json()
}

function extractTextFromCompletionContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const item = part as Record<string, unknown>
      if (typeof item.text === 'string') return item.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function getLocalCompletionTimeoutMs(): number {
  const configured = Number(process.env.LOCAL_AI_TIMEOUT_MS)
  if (Number.isFinite(configured) && configured >= 30_000) return configured
  return 180_000
}

export async function createLocalChatCompletion(options: {
  baseUrl: string
  apiKey?: string
  model?: string
  maxTokens?: number
  messages: LocalChatMessage[]
}): Promise<LocalChatCompletionResult> {
  const normalizedBaseUrl = normalizeLocalBaseUrl(options.baseUrl)
  if (!normalizedBaseUrl) throw new Error('Invalid local base URL')

  const headers: HeadersInit = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  if (options.apiKey?.trim()) headers.Authorization = `Bearer ${options.apiKey.trim()}`

  const payload: Record<string, unknown> = {
    messages: options.messages,
  }

  if (typeof options.maxTokens === 'number') {
    payload.max_tokens = options.maxTokens
  }

  if (options.model?.trim()) {
    payload.model = options.model.trim()
  }

  const response = await fetch(buildUrl(normalizedBaseUrl, '/chat/completions'), {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(getLocalCompletionTimeoutMs()),
    cache: 'no-store',
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(`${response.status} ${response.statusText}${errorText ? `: ${errorText.slice(0, 200)}` : ''}`)
  }

  const data = await response.json() as {
    model?: unknown
    choices?: Array<{
      message?: {
        content?: unknown
      }
    }>
  }

  const text = extractTextFromCompletionContent(data.choices?.[0]?.message?.content)

  return {
    text,
    model: typeof data.model === 'string' && data.model.trim() ? data.model.trim() : null,
  }
}

function sourceRank(source: LocalModelSource): number {
  switch (source) {
    case 'runtime-active':
      return 3
    case 'openai-compatible':
      return 2
    case 'runtime-catalog':
      return 1
  }
}

function mergeModelLists(lists: LocalModelOption[][]): LocalModelOption[] {
  const merged = new Map<string, LocalModelOption>()

  for (const list of lists) {
    for (const model of list) {
      const existing = merged.get(model.id)
      if (!existing) {
        merged.set(model.id, model)
        continue
      }

      merged.set(model.id, {
        ...existing,
        source: sourceRank(model.source) > sourceRank(existing.source) ? model.source : existing.source,
        loaded: existing.loaded || model.loaded,
      })
    }
  }

  return Array.from(merged.values()).sort((a, b) => {
    if (a.loaded !== b.loaded) return a.loaded ? -1 : 1
    return a.label.localeCompare(b.label)
  })
}

export async function discoverLocalModels(options: {
  baseUrl: string
  apiKey?: string
}): Promise<LocalModelOption[]> {
  const normalizedBaseUrl = normalizeLocalBaseUrl(options.baseUrl)
  if (!normalizedBaseUrl) throw new Error('Invalid local base URL')

  const ollamaRootUrl = getOllamaRootUrl(normalizedBaseUrl)
  const failures: unknown[] = []

  try {
    const openAIModels = parseOpenAIModels(
      await fetchJson(buildUrl(normalizedBaseUrl, '/models'), options.apiKey),
    )
    if (openAIModels.length > 0) return openAIModels
  } catch (err) {
    failures.push(err)
  }

  const results = await Promise.allSettled([
    fetchJson(buildUrl(ollamaRootUrl, '/api/ps'), options.apiKey).then((payload) => parseRuntimeModels(payload, 'runtime-active')),
    fetchJson(buildUrl(ollamaRootUrl, '/api/tags'), options.apiKey).then((payload) => parseRuntimeModels(payload, 'runtime-catalog')),
  ])

  const modelLists = results
    .filter((result): result is PromiseFulfilledResult<LocalModelOption[]> => result.status === 'fulfilled')
    .map((result) => result.value)

  const merged = mergeModelLists(modelLists)
  if (merged.length > 0) return merged

  const firstFailure =
    failures[0] ??
    results.find((result): result is PromiseRejectedResult => result.status === 'rejected')?.reason
  if (firstFailure) {
    throw new Error(firstFailure instanceof Error ? firstFailure.message : 'Model discovery failed')
  }

  return []
}
