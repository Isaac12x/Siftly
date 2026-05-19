import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { discoverLocalModels, normalizeLocalBaseUrl } from '@/lib/local-ai'
import {
  DEFAULT_LOCAL_BASE_URL,
  loadLocalEndpointState,
} from '@/lib/local-endpoints'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url)
  const requestedEndpointId = url.searchParams.get('endpointId')?.trim()
  const requestedBaseUrl = url.searchParams.get('baseUrl')?.trim()
  const requestedModel = url.searchParams.get('model')?.trim()

  const [localEndpointState, savedKey] = await Promise.all([
    loadLocalEndpointState(),
    prisma.setting.findUnique({ where: { key: 'localApiKey' } }),
  ])

  const endpoint =
    localEndpointState.endpoints.find((item) => item.id === requestedEndpointId) ||
    localEndpointState.activeEndpoint

  const baseUrl = normalizeLocalBaseUrl(requestedBaseUrl ?? '') || endpoint?.baseUrl || DEFAULT_LOCAL_BASE_URL
  const selectedModel = requestedModel ?? endpoint?.model ?? ''

  try {
    const models = await discoverLocalModels({
      baseUrl,
      apiKey: savedKey?.value?.trim(),
    })

    return NextResponse.json(
      {
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        baseUrl,
        selectedModel,
        selectedModelLoaded: Boolean(selectedModel) && models.some((model) => model.id === selectedModel),
        models,
      },
      {
        headers: { 'Cache-Control': 'no-store' },
      },
    )
  } catch (err) {
    return NextResponse.json(
      {
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        baseUrl,
        selectedModel,
        selectedModelLoaded: false,
        models: [],
        error: err instanceof Error ? err.message : 'Failed to discover local models',
      },
      {
        headers: { 'Cache-Control': 'no-store' },
      },
    )
  }
}
