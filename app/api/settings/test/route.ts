import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { resolveAnthropicClient, getCliAuthStatus } from '@/lib/claude-cli-auth'
import { resolveOpenAIClient } from '@/lib/openai-auth'
import { resolveMiniMaxClient } from '@/lib/minimax-auth'
import { getLocalBaseUrl, getLocalModel } from '@/lib/settings'
import { createLocalChatCompletion, normalizeLocalBaseUrl, type LocalChatCompletionResult } from '@/lib/local-ai'
import { loadLocalEndpointState } from '@/lib/local-endpoints'

function extractErrorText(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object') return trimmed

    const queue: unknown[] = [parsed]
    while (queue.length > 0) {
      const item = queue.shift()
      if (!item || typeof item !== 'object') continue

      const record = item as Record<string, unknown>
      for (const key of ['message', 'error', 'detail']) {
        const value = record[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
        if (value && typeof value === 'object') queue.push(value)
      }
    }
  } catch {
    return trimmed
  }

  return trimmed
}

function extractErrorDetail(message: string): string | null {
  const firstColon = message.indexOf(':')
  if (firstColon === -1) return null
  return extractErrorText(message.slice(firstColon + 1))
}

function truncate(value: string, maxLength = 1_200): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}

function formatModelReturn(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return '(empty response)'

  try {
    return truncate(JSON.stringify(JSON.parse(trimmed), null, 2))
  } catch {
    return truncate(trimmed)
  }
}

function buildBookmarkProcessingPrompt(bookmark: {
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
}): string {
  return `Process this Twitter/X bookmark for a bookmark intelligence app.

Return ONLY valid JSON, no markdown, no explanation, in exactly this shape:
{
  "tweetId": "${bookmark.tweetId}",
  "summary": "one concise sentence",
  "topics": ["2-5 short searchable topics"],
  "works": true
}

Bookmark:
${JSON.stringify({
  tweetId: bookmark.tweetId,
  author: bookmark.authorHandle || bookmark.authorName,
  text: bookmark.text.slice(0, 1_200),
}, null, 2)}`
}

function parseBookmarkProcessingResponse(raw: string, expectedTweetId: string): void {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('The model returned an empty response.')

  const jsonMatch = trimmed.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('The model did not return a JSON object.')

  const parsed = JSON.parse(jsonMatch[0]) as unknown
  if (!parsed || typeof parsed !== 'object') throw new Error('The model response was not a JSON object.')

  const record = parsed as Record<string, unknown>
  if (record.tweetId !== expectedTweetId) {
    throw new Error('The model response did not preserve the bookmark tweetId.')
  }
  if (record.works !== true) {
    throw new Error('The model response did not mark processing as working.')
  }
  if (typeof record.summary !== 'string' || !record.summary.trim()) {
    throw new Error('The model response did not include a summary.')
  }
  if (!Array.isArray(record.topics) || record.topics.length === 0) {
    throw new Error('The model response did not include topics.')
  }
}

function formatBookmarkProcessingError(options: {
  bookmark: { tweetId: string; text: string }
  reason: string
  modelReturn?: string
}): string {
  const lines = [
    'Endpoint responded, but the model could not process a real bookmark.',
    `Reason: ${options.reason}`,
    `Bookmark: ${options.bookmark.tweetId} - ${truncate(options.bookmark.text.replace(/\s+/g, ' '), 180)}`,
  ]

  if (options.modelReturn !== undefined) {
    lines.push('Model return:', formatModelReturn(options.modelReturn))
  }

  return lines.join('\n')
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { provider?: string; endpointId?: string; baseUrl?: string; model?: string } = {}
  try {
    const text = await request.text()
    if (text.trim()) body = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const provider = body.provider ?? 'anthropic'

  if (provider === 'anthropic') {
    const setting = await prisma.setting.findUnique({ where: { key: 'anthropicApiKey' } })
    const dbKey = setting?.value?.trim()

    let client
    try {
      client = resolveAnthropicClient({ dbKey })
    } catch {
      const cliStatus = getCliAuthStatus()
      if (cliStatus.available && cliStatus.expired) {
        return NextResponse.json({ working: false, error: 'Claude CLI session expired — run `claude` to refresh' })
      }
      return NextResponse.json({ working: false, error: 'No API key found. Add one in Settings or log in with Claude CLI.' })
    }

    try {
      await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'hi' }],
      })
      return NextResponse.json({ working: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const friendly = msg.includes('401') || msg.includes('invalid_api_key')
        ? 'Invalid API key'
        : msg.includes('403')
        ? 'Key does not have permission'
        : msg.slice(0, 120)
      return NextResponse.json({ working: false, error: friendly })
    }
  }

  if (provider === 'openai') {
    const setting = await prisma.setting.findUnique({ where: { key: 'openaiApiKey' } })
    const dbKey = setting?.value?.trim()

    let client
    try {
      client = resolveOpenAIClient({ dbKey })
    } catch {
      return NextResponse.json({ working: false, error: 'No OpenAI API key found. Add one in Settings or set up Codex CLI.' })
    }

    try {
      await client.chat.completions.create({
        model: 'gpt-4.1-mini',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'hi' }],
      })
      return NextResponse.json({ working: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const friendly = msg.includes('401') || msg.includes('invalid_api_key')
        ? 'Invalid API key'
        : msg.includes('403')
        ? 'Key does not have permission'
        : msg.slice(0, 120)
      return NextResponse.json({ working: false, error: friendly })
    }
  }

  if (provider === 'minimax') {
    const setting = await prisma.setting.findUnique({ where: { key: 'minimaxApiKey' } })
    const dbKey = setting?.value?.trim()

    let client
    try {
      client = resolveMiniMaxClient({ dbKey })
    } catch {
      return NextResponse.json({ working: false, error: 'No MiniMax API key found. Add one in Settings or set MINIMAX_API_KEY.' })
    }

    try {
      await client.chat.completions.create({
        model: 'MiniMax-M2.7',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'hi' }],
      })
      return NextResponse.json({ working: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const friendly = msg.includes('401') || msg.includes('invalid_api_key')
        ? 'Invalid API key'
        : msg.includes('403')
        ? 'Key does not have permission'
        : msg.slice(0, 120)
      return NextResponse.json({ working: false, error: friendly })
    }
  }

  if (provider === 'local') {
    const setting = await prisma.setting.findUnique({ where: { key: 'localApiKey' } })
    const dbKey = setting?.value?.trim()
    const endpointId = body.endpointId?.trim()
    const localEndpointState = endpointId ? await loadLocalEndpointState() : null
    const activeEndpoint = endpointId
      ? localEndpointState?.endpoints.find((endpoint) => endpoint.id === endpointId) ?? localEndpointState?.activeEndpoint
      : null
    const baseUrl =
      normalizeLocalBaseUrl(body.baseUrl ?? '') ??
      activeEndpoint?.baseUrl ??
      await getLocalBaseUrl()
    const model =
      typeof body.model === 'string'
        ? body.model.trim()
        : activeEndpoint?.model ?? await getLocalModel()

    try {
      const result = await createLocalChatCompletion({
        baseUrl,
        apiKey: dbKey,
        model,
        maxTokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      })

      const sampleBookmark = await prisma.bookmark.findFirst({
        orderBy: { importedAt: 'desc' },
        select: {
          tweetId: true,
          text: true,
          authorHandle: true,
          authorName: true,
        },
      })

      if (!sampleBookmark) {
        return NextResponse.json({
          working: true,
          model: model || result.model || null,
          discoveredModel: result.model,
          bookmarkTest: { skipped: true, reason: 'No bookmarks available to test processing.' },
        })
      }

      let bookmarkResult: LocalChatCompletionResult | undefined
      try {
        bookmarkResult = await createLocalChatCompletion({
          baseUrl,
          apiKey: dbKey,
          model,
          maxTokens: 300,
          messages: [{ role: 'user', content: buildBookmarkProcessingPrompt(sampleBookmark) }],
        })
        parseBookmarkProcessingResponse(bookmarkResult.text, sampleBookmark.tweetId)
      } catch (processingErr) {
        const reason = processingErr instanceof Error ? processingErr.message : String(processingErr)
        return NextResponse.json({
          working: false,
          model: model || result.model || null,
          discoveredModel: result.model,
          error: formatBookmarkProcessingError({
            bookmark: sampleBookmark,
            reason,
            modelReturn: bookmarkResult?.text,
          }),
        })
      }

      return NextResponse.json({
        working: true,
        model: model || result.model || null,
        discoveredModel: result.model,
        bookmarkTest: {
          skipped: false,
          tweetId: sampleBookmark.tweetId,
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const detail = extractErrorDetail(msg)
      const combined = `${msg}\n${detail ?? ''}`.toLowerCase()
      const resolvedModel = model.trim()
      const friendly =
        msg.includes('ECONNREFUSED') || msg.includes('fetch failed')
          ? 'Could not reach the local model endpoint'
          : !model && (msg.includes('400') || msg.includes('422'))
              ? 'Endpoint requires an explicit model ID. Enter one or pick a discovered model.'
            : combined.includes('model') && (
                combined.includes('not found') ||
                combined.includes('unknown model') ||
                combined.includes('does not exist') ||
                combined.includes('no such model')
              )
              ? resolvedModel
                ? `Model "${resolvedModel}" is not available on this endpoint`
                : 'The selected model is not available on this endpoint'
            : msg.includes('404')
              ? detail
                ? `Endpoint returned 404: ${detail}. Check the base URL and use the server root or /v1, not the full /chat/completions path.`
                : 'Endpoint returned 404 from /chat/completions. Check the base URL and use the server root or /v1, not the full /chat/completions path.'
            : msg.includes('401') || msg.includes('invalid_api_key')
              ? 'Invalid local API key'
              : (detail || msg).slice(0, 160)
      return NextResponse.json({ working: false, error: friendly })
    }
  }

  return NextResponse.json({ error: 'Unknown provider' }, { status: 400 })
}
