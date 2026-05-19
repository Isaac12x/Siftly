import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_MINIMAX_MODEL,
  DEFAULT_OPENAI_MODEL,
  invalidateSettingsCache,
} from '@/lib/settings'
import { validateVaultPath } from '@/lib/obsidian-exporter'
import { discoverLocalModels, normalizeLocalBaseUrl, type LocalModelOption } from '@/lib/local-ai'
import {
  DEFAULT_LOCAL_BASE_URL,
  DEFAULT_LOCAL_MODEL,
  loadLocalEndpointState,
  normalizeLocalEndpointsInput,
  persistLocalEndpointState,
  type LocalEndpoint,
} from '@/lib/local-endpoints'

function maskKey(raw: string | null): string | null {
  if (!raw) return null
  if (raw.length <= 8) return '********'
  return `${raw.slice(0, 6)}${'*'.repeat(raw.length - 10)}${raw.slice(-4)}`
}

const ALLOWED_ANTHROPIC_MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
] as const

const ALLOWED_OPENAI_MODELS = [
  'gpt-4.1-mini',
  'gpt-4.1',
  'gpt-4.1-nano',
  'o4-mini',
  'o3',
] as const

const ALLOWED_MINIMAX_MODELS = [
  'MiniMax-M2.7',
  'MiniMax-M2.5',
  'MiniMax-M2.5-highspeed',
] as const

async function maybeAutoSelectLocalModel(endpoint: LocalEndpoint, apiKey?: string): Promise<LocalEndpoint | null> {
  const [localKey, localModel] = await Promise.all([
    apiKey === undefined
      ? prisma.setting.findUnique({ where: { key: 'localApiKey' } }).then((setting) => setting?.value?.trim() || '')
      : Promise.resolve(apiKey.trim()),
    Promise.resolve(endpoint.model.trim()),
  ])

  let models: LocalModelOption[] = []
  try {
    models = await discoverLocalModels({
      baseUrl: endpoint.baseUrl,
      apiKey: localKey,
    })
  } catch {
    return null
  }

  if (models.length === 0) return null

  const currentModel = localModel
  if (currentModel && models.some((model) => model.id === currentModel)) {
    return null
  }

  return {
    ...endpoint,
    model: models[0].id,
  }
}

export async function GET(): Promise<NextResponse> {
  try {
    const [
      anthropic,
      anthropicModel,
      provider,
      openai,
      openaiModel,
      minimax,
      minimaxModel,
      local,
      localEndpointState,
      xClientId,
      xClientSecret,
      obsidianVault,
      webhook,
    ] = await Promise.all([
      prisma.setting.findUnique({ where: { key: 'anthropicApiKey' } }),
      prisma.setting.findUnique({ where: { key: 'anthropicModel' } }),
      prisma.setting.findUnique({ where: { key: 'aiProvider' } }),
      prisma.setting.findUnique({ where: { key: 'openaiApiKey' } }),
      prisma.setting.findUnique({ where: { key: 'openaiModel' } }),
      prisma.setting.findUnique({ where: { key: 'minimaxApiKey' } }),
      prisma.setting.findUnique({ where: { key: 'minimaxModel' } }),
      prisma.setting.findUnique({ where: { key: 'localApiKey' } }),
      loadLocalEndpointState(),
      prisma.setting.findUnique({ where: { key: 'x_oauth_client_id' } }),
      prisma.setting.findUnique({ where: { key: 'x_oauth_client_secret' } }),
      prisma.setting.findUnique({ where: { key: 'obsidianVaultPath' } }),
      prisma.setting.findUnique({ where: { key: 'webhookUrl' } }),
    ])

    const providerValue =
      provider?.value === 'openai' || provider?.value === 'minimax' || provider?.value === 'local'
        ? provider.value
        : 'anthropic'

    return NextResponse.json({
      provider: providerValue,
      anthropicApiKey: maskKey(anthropic?.value ?? null),
      hasAnthropicKey: anthropic !== null,
      anthropicModel: anthropicModel?.value ?? DEFAULT_ANTHROPIC_MODEL,
      openaiApiKey: maskKey(openai?.value ?? null),
      hasOpenaiKey: openai !== null,
      openaiModel: openaiModel?.value ?? DEFAULT_OPENAI_MODEL,
      minimaxApiKey: maskKey(minimax?.value ?? null),
      hasMinimaxKey: minimax !== null,
      minimaxModel: minimaxModel?.value ?? DEFAULT_MINIMAX_MODEL,
      localApiKey: maskKey(local?.value ?? null),
      hasLocalKey: local !== null,
      localModel: localEndpointState.activeEndpoint.model ?? DEFAULT_LOCAL_MODEL,
      localBaseUrl: localEndpointState.activeEndpoint.baseUrl ?? DEFAULT_LOCAL_BASE_URL,
      localEndpoints: localEndpointState.endpoints,
      activeLocalEndpointId: localEndpointState.activeEndpointId,
      xOAuthClientId: maskKey(xClientId?.value ?? null),
      xOAuthClientSecret: maskKey(xClientSecret?.value ?? null),
      hasXOAuth: !!xClientId?.value,
      obsidianVaultPath: obsidianVault?.value ?? null,
      webhookUrl: webhook?.value ?? null,
    })
  } catch (err) {
    console.error('Settings GET error:', err)
    return NextResponse.json(
      { error: `Failed to fetch settings: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: {
    anthropicApiKey?: string
    anthropicModel?: string
    provider?: string
    openaiApiKey?: string
    openaiModel?: string
    minimaxApiKey?: string
    minimaxModel?: string
    localApiKey?: string
    localModel?: string
    localBaseUrl?: string
    localEndpoints?: unknown
    activeLocalEndpointId?: string
    xOAuthClientId?: string
    xOAuthClientSecret?: string
    obsidianVaultPath?: string
    webhookUrl?: string
  } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const {
    anthropicApiKey,
    anthropicModel,
    provider,
    openaiApiKey,
    openaiModel,
    minimaxApiKey,
    minimaxModel,
    localApiKey,
    localModel,
    localBaseUrl,
    localEndpoints,
    activeLocalEndpointId,
  } = body

  // Save provider if provided
  if (provider !== undefined) {
    if (provider !== 'anthropic' && provider !== 'openai' && provider !== 'minimax' && provider !== 'local') {
      return NextResponse.json({ error: 'Invalid provider' }, { status: 400 })
    }
    await prisma.setting.upsert({
      where: { key: 'aiProvider' },
      update: { value: provider },
      create: { key: 'aiProvider', value: provider },
    })
    invalidateSettingsCache()
    return NextResponse.json({ saved: true })
  }

  // Save Anthropic model if provided
  if (anthropicModel !== undefined) {
    if (!(ALLOWED_ANTHROPIC_MODELS as readonly string[]).includes(anthropicModel)) {
      return NextResponse.json({ error: 'Invalid Anthropic model' }, { status: 400 })
    }
    await prisma.setting.upsert({
      where: { key: 'anthropicModel' },
      update: { value: anthropicModel },
      create: { key: 'anthropicModel', value: anthropicModel },
    })
    invalidateSettingsCache()
    return NextResponse.json({ saved: true })
  }

  // Save OpenAI model if provided
  if (openaiModel !== undefined) {
    if (!(ALLOWED_OPENAI_MODELS as readonly string[]).includes(openaiModel)) {
      return NextResponse.json({ error: 'Invalid OpenAI model' }, { status: 400 })
    }
    await prisma.setting.upsert({
      where: { key: 'openaiModel' },
      update: { value: openaiModel },
      create: { key: 'openaiModel', value: openaiModel },
    })
    invalidateSettingsCache()
    return NextResponse.json({ saved: true })
  }

  // Save MiniMax model if provided
  if (minimaxModel !== undefined) {
    if (!(ALLOWED_MINIMAX_MODELS as readonly string[]).includes(minimaxModel)) {
      return NextResponse.json({ error: 'Invalid MiniMax model' }, { status: 400 })
    }
    await prisma.setting.upsert({
      where: { key: 'minimaxModel' },
      update: { value: minimaxModel },
      create: { key: 'minimaxModel', value: minimaxModel },
    })
    invalidateSettingsCache()
    return NextResponse.json({ saved: true })
  }

  if (
    localEndpoints !== undefined ||
    activeLocalEndpointId !== undefined ||
    localModel !== undefined ||
    localBaseUrl !== undefined
  ) {
    const localEndpointState = await loadLocalEndpointState()
    let nextEndpoints = localEndpointState.endpoints
    let nextActiveEndpointId = activeLocalEndpointId?.trim() || localEndpointState.activeEndpointId

    if (localEndpoints !== undefined) {
      try {
        nextEndpoints = normalizeLocalEndpointsInput(localEndpoints)
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : 'Invalid local endpoints payload' },
          { status: 400 },
        )
      }
    }

    if (localBaseUrl !== undefined || localModel !== undefined) {
      let normalizedBaseUrl: string | null = null
      if (localBaseUrl !== undefined) {
        if (typeof localBaseUrl !== 'string') {
          return NextResponse.json({ error: 'Invalid local base URL' }, { status: 400 })
        }
        normalizedBaseUrl = normalizeLocalBaseUrl(localBaseUrl)
        if (!normalizedBaseUrl) {
          return NextResponse.json(
            { error: 'Invalid local base URL. Use a full http:// or https:// URL.' },
            { status: 400 },
          )
        }
      }

      let trimmedModel: string | null = null
      if (localModel !== undefined) {
        if (typeof localModel !== 'string' || localModel.trim() === '') {
          return NextResponse.json({ error: 'Invalid local model' }, { status: 400 })
        }
        trimmedModel = localModel.trim()
      }

      nextEndpoints = nextEndpoints.map((endpoint) => {
        if (endpoint.id !== nextActiveEndpointId) return endpoint

        return {
          ...endpoint,
          ...(normalizedBaseUrl ? { baseUrl: normalizedBaseUrl } : {}),
          ...(trimmedModel ? { model: trimmedModel } : {}),
        }
      })
    }

    if (!nextEndpoints.some((endpoint) => endpoint.id === nextActiveEndpointId)) {
      nextActiveEndpointId = nextEndpoints[0]?.id || localEndpointState.activeEndpointId
    }

    const persisted = await persistLocalEndpointState({
      endpoints: nextEndpoints,
      activeEndpointId: nextActiveEndpointId,
    })
    invalidateSettingsCache()
    return NextResponse.json({
      saved: true,
      localEndpoints: persisted.endpoints,
      activeLocalEndpointId: persisted.activeEndpointId,
      selectedModel: persisted.activeEndpoint.model,
    })
  }

  // Save Anthropic key if provided
  if (anthropicApiKey !== undefined) {
    if (typeof anthropicApiKey !== 'string' || anthropicApiKey.trim() === '') {
      return NextResponse.json({ error: 'Invalid anthropicApiKey value' }, { status: 400 })
    }
    const trimmed = anthropicApiKey.trim()
    try {
      await prisma.setting.upsert({
        where: { key: 'anthropicApiKey' },
        update: { value: trimmed },
        create: { key: 'anthropicApiKey', value: trimmed },
      })
      invalidateSettingsCache()
      return NextResponse.json({ saved: true })
    } catch (err) {
      console.error('Settings POST (anthropic) error:', err)
      return NextResponse.json(
        { error: `Failed to save: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 }
      )
    }
  }

  // Save OpenAI key if provided
  if (openaiApiKey !== undefined) {
    if (typeof openaiApiKey !== 'string' || openaiApiKey.trim() === '') {
      return NextResponse.json({ error: 'Invalid openaiApiKey value' }, { status: 400 })
    }
    const trimmed = openaiApiKey.trim()
    try {
      await prisma.setting.upsert({
        where: { key: 'openaiApiKey' },
        update: { value: trimmed },
        create: { key: 'openaiApiKey', value: trimmed },
      })
      invalidateSettingsCache()
      return NextResponse.json({ saved: true })
    } catch (err) {
      console.error('Settings POST (openai) error:', err)
      return NextResponse.json(
        { error: `Failed to save: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 }
      )
    }
  }

  // Save MiniMax key if provided
  if (minimaxApiKey !== undefined) {
    if (typeof minimaxApiKey !== 'string' || minimaxApiKey.trim() === '') {
      return NextResponse.json({ error: 'Invalid minimaxApiKey value' }, { status: 400 })
    }
    const trimmed = minimaxApiKey.trim()
    try {
      await prisma.setting.upsert({
        where: { key: 'minimaxApiKey' },
        update: { value: trimmed },
        create: { key: 'minimaxApiKey', value: trimmed },
      })
      invalidateSettingsCache()
      return NextResponse.json({ saved: true })
    } catch (err) {
      console.error('Settings POST (minimax) error:', err)
      return NextResponse.json(
        { error: `Failed to save: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 }
      )
    }
  }

  // Save Local key if provided
  if (localApiKey !== undefined) {
    if (typeof localApiKey !== 'string' || localApiKey.trim() === '') {
      return NextResponse.json({ error: 'Invalid localApiKey value' }, { status: 400 })
    }
    const trimmed = localApiKey.trim()
    try {
      await prisma.setting.upsert({
        where: { key: 'localApiKey' },
        update: { value: trimmed },
        create: { key: 'localApiKey', value: trimmed },
      })
      const localEndpointState = await loadLocalEndpointState()
      const nextEndpoint = await maybeAutoSelectLocalModel(localEndpointState.activeEndpoint, trimmed)
      if (nextEndpoint) {
        await persistLocalEndpointState({
          endpoints: localEndpointState.endpoints.map((endpoint) =>
            endpoint.id === localEndpointState.activeEndpointId ? nextEndpoint : endpoint,
          ),
          activeEndpointId: localEndpointState.activeEndpointId,
        })
      }
      invalidateSettingsCache()
      return NextResponse.json({ saved: true, selectedModel: nextEndpoint?.model ?? localEndpointState.activeEndpoint.model })
    } catch (err) {
      console.error('Settings POST (local) error:', err)
      return NextResponse.json(
        { error: `Failed to save: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 }
      )
    }
  }

  // Save webhook URL if provided
  if (body.webhookUrl !== undefined) {
    const trimmed = body.webhookUrl.trim()
    if (trimmed === '') {
      await prisma.setting.deleteMany({ where: { key: 'webhookUrl' } })
    } else {
      await prisma.setting.upsert({
        where: { key: 'webhookUrl' },
        update: { value: trimmed },
        create: { key: 'webhookUrl', value: trimmed },
      })
    }
    invalidateSettingsCache()
    return NextResponse.json({ saved: true })
  }

  // Save Obsidian vault path if provided
  if (body.obsidianVaultPath !== undefined) {
    const trimmed = body.obsidianVaultPath.trim()
    if (!trimmed) {
      await prisma.setting.deleteMany({ where: { key: 'obsidianVaultPath' } })
      return NextResponse.json({ saved: true })
    }
    const validation = await validateVaultPath(trimmed)
    if (!validation.valid) {
      return NextResponse.json({ error: `Invalid vault path: ${validation.error}` }, { status: 400 })
    }
    await prisma.setting.upsert({
      where: { key: 'obsidianVaultPath' },
      update: { value: trimmed },
      create: { key: 'obsidianVaultPath', value: trimmed },
    })
    return NextResponse.json({ saved: true })
  }

  // Save X OAuth credentials if provided
  const { xOAuthClientId, xOAuthClientSecret } = body
  const xKeys: { key: string; value: string | undefined }[] = [
    { key: 'x_oauth_client_id', value: xOAuthClientId },
    { key: 'x_oauth_client_secret', value: xOAuthClientSecret },
  ]
  const xToSave = xKeys.filter((k) => k.value !== undefined && k.value.trim() !== '')
  if (xToSave.length > 0) {
    try {
      for (const { key, value } of xToSave) {
        await prisma.setting.upsert({
          where: { key },
          update: { value: value!.trim() },
          create: { key, value: value!.trim() },
        })
      }
      return NextResponse.json({ saved: true })
    } catch (err) {
      console.error('Settings POST (X OAuth) error:', err)
      return NextResponse.json(
        { error: `Failed to save: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 },
      )
    }
  }

  return NextResponse.json({ error: 'No setting provided' }, { status: 400 })
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  let body: { key?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const allowed = [
    'anthropicApiKey',
    'openaiApiKey',
    'minimaxApiKey',
    'localApiKey',
    'localBaseUrl',
    'x_oauth_client_id',
    'x_oauth_client_secret',
    'webhookUrl',
    'obsidianVaultPath',
  ]
  if (!body.key || !allowed.includes(body.key)) {
    return NextResponse.json({ error: 'Invalid key' }, { status: 400 })
  }

  await prisma.setting.deleteMany({ where: { key: body.key } })
  invalidateSettingsCache()
  return NextResponse.json({ deleted: true })
}
