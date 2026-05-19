import prisma from '@/lib/db'
import { normalizeLocalBaseUrl } from '@/lib/local-ai'

export const LOCAL_ENDPOINTS_SETTING_KEY = 'localEndpoints'
export const ACTIVE_LOCAL_ENDPOINT_SETTING_KEY = 'activeLocalEndpointId'

export const DEFAULT_LOCAL_MODEL = process.env.LOCAL_AI_MODEL?.trim() || 'llama3.2'
export const DEFAULT_LOCAL_BASE_URL =
  process.env.LOCAL_AI_BASE_URL?.trim() ||
  process.env.OPENAI_BASE_URL?.trim() ||
  'http://127.0.0.1:11434/v1'

export interface LocalEndpoint {
  id: string
  name: string
  baseUrl: string
  model: string
}

export interface LocalEndpointState {
  endpoints: LocalEndpoint[]
  activeEndpointId: string
  activeEndpoint: LocalEndpoint
}

function makeEndpointId(index: number): string {
  return `local-endpoint-${index + 1}`
}

function normalizeEndpointName(value: unknown, index: number): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  return `Local endpoint ${index + 1}`
}

function normalizeEndpointModel(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  return ''
}

function normalizeEndpointId(value: unknown, index: number, seen: Set<string>): string {
  const preferred = typeof value === 'string' && value.trim() ? value.trim() : makeEndpointId(index)
  if (!seen.has(preferred)) {
    seen.add(preferred)
    return preferred
  }

  let suffix = 2
  let next = `${preferred}-${suffix}`
  while (seen.has(next)) {
    suffix += 1
    next = `${preferred}-${suffix}`
  }
  seen.add(next)
  return next
}

function normalizeEndpointRecord(
  value: unknown,
  index: number,
  seen: Set<string>,
): LocalEndpoint | null {
  if (!value || typeof value !== 'object') return null

  const item = value as Record<string, unknown>
  const baseUrl = normalizeLocalBaseUrl(typeof item.baseUrl === 'string' ? item.baseUrl : '')
  if (!baseUrl) return null

  return {
    id: normalizeEndpointId(item.id, index, seen),
    name: normalizeEndpointName(item.name, index),
    baseUrl,
    model: normalizeEndpointModel(item.model),
  }
}

function buildFallbackEndpoint(legacyBaseUrl?: string | null, legacyModel?: string | null): LocalEndpoint {
  return {
    id: makeEndpointId(0),
    name: 'Default local endpoint',
    baseUrl: normalizeLocalBaseUrl(legacyBaseUrl ?? '') || DEFAULT_LOCAL_BASE_URL,
    model: legacyModel?.trim() || DEFAULT_LOCAL_MODEL,
  }
}

export function parseLocalEndpoints(raw: string | null | undefined): LocalEndpoint[] {
  if (!raw?.trim()) return []

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []

    const seen = new Set<string>()
    return parsed
      .map((item, index) => normalizeEndpointRecord(item, index, seen))
      .filter((item): item is LocalEndpoint => Boolean(item))
  } catch {
    return []
  }
}

export function normalizeLocalEndpointsInput(raw: unknown): LocalEndpoint[] {
  if (!Array.isArray(raw)) {
    throw new Error('Invalid local endpoints payload')
  }

  const seen = new Set<string>()
  const endpoints = raw.map((item, index) => {
    const normalized = normalizeEndpointRecord(item, index, seen)
    if (!normalized) {
      throw new Error(`Local endpoint ${index + 1} needs a valid http:// or https:// base URL`)
    }
    return normalized
  })

  if (endpoints.length === 0) {
    throw new Error('Add at least one local endpoint')
  }

  return endpoints
}

export async function loadLocalEndpointState(): Promise<LocalEndpointState> {
  const [storedEndpoints, storedActiveId, legacyBaseUrl, legacyModel] = await Promise.all([
    prisma.setting.findUnique({ where: { key: LOCAL_ENDPOINTS_SETTING_KEY } }),
    prisma.setting.findUnique({ where: { key: ACTIVE_LOCAL_ENDPOINT_SETTING_KEY } }),
    prisma.setting.findUnique({ where: { key: 'localBaseUrl' } }),
    prisma.setting.findUnique({ where: { key: 'localModel' } }),
  ])

  const endpoints = parseLocalEndpoints(storedEndpoints?.value)
  const fallback = buildFallbackEndpoint(legacyBaseUrl?.value, legacyModel?.value)
  const normalizedEndpoints = endpoints.length > 0 ? endpoints : [fallback]

  const activeEndpointId = storedActiveId?.value?.trim()
  const activeEndpoint =
    normalizedEndpoints.find((endpoint) => endpoint.id === activeEndpointId) ??
    normalizedEndpoints[0]

  return {
    endpoints: normalizedEndpoints,
    activeEndpointId: activeEndpoint.id,
    activeEndpoint,
  }
}

export async function hasConfiguredLocalEndpoint(): Promise<boolean> {
  const [storedEndpoints, storedActiveId, legacyBaseUrl, legacyModel] = await Promise.all([
    prisma.setting.findUnique({ where: { key: LOCAL_ENDPOINTS_SETTING_KEY } }),
    prisma.setting.findUnique({ where: { key: ACTIVE_LOCAL_ENDPOINT_SETTING_KEY } }),
    prisma.setting.findUnique({ where: { key: 'localBaseUrl' } }),
    prisma.setting.findUnique({ where: { key: 'localModel' } }),
  ])

  if (parseLocalEndpoints(storedEndpoints?.value).length > 0) return true

  return Boolean(
    storedActiveId?.value?.trim() ||
    legacyBaseUrl?.value?.trim() ||
    legacyModel?.value?.trim(),
  )
}

export async function persistLocalEndpointState(options: {
  endpoints: LocalEndpoint[]
  activeEndpointId?: string
}): Promise<LocalEndpointState> {
  const endpoints = options.endpoints.length > 0
    ? options.endpoints
    : [buildFallbackEndpoint(null, null)]

  const activeEndpoint =
    endpoints.find((endpoint) => endpoint.id === options.activeEndpointId) ??
    endpoints[0]

  await prisma.$transaction(async (tx) => {
    await tx.setting.upsert({
      where: { key: LOCAL_ENDPOINTS_SETTING_KEY },
      update: { value: JSON.stringify(endpoints) },
      create: { key: LOCAL_ENDPOINTS_SETTING_KEY, value: JSON.stringify(endpoints) },
    })

    await tx.setting.upsert({
      where: { key: ACTIVE_LOCAL_ENDPOINT_SETTING_KEY },
      update: { value: activeEndpoint.id },
      create: { key: ACTIVE_LOCAL_ENDPOINT_SETTING_KEY, value: activeEndpoint.id },
    })

    await tx.setting.upsert({
      where: { key: 'localBaseUrl' },
      update: { value: activeEndpoint.baseUrl },
      create: { key: 'localBaseUrl', value: activeEndpoint.baseUrl },
    })

    await tx.setting.upsert({
      where: { key: 'localModel' },
      update: { value: activeEndpoint.model },
      create: { key: 'localModel', value: activeEndpoint.model },
    })
  })

  return {
    endpoints,
    activeEndpointId: activeEndpoint.id,
    activeEndpoint,
  }
}
