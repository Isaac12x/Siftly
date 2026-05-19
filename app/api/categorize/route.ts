import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { AIClient, resolveAIClient } from '@/lib/ai-client'
import { getActiveModel, getApiKeySettingKey, getProvider, getWebhookUrl } from '@/lib/settings'
import {
  seedDefaultCategories,
  categorizeBatch,
  discoverCategoriesFromBookmarks,
  mapBookmarkForCategorization,
  writeCategoryResults,
  BOOKMARK_SELECT,
} from '@/lib/categorizer'
import {
  analyzeItem,
  runWithConcurrency,
  enrichBatchSemanticTags,
  BookmarkForEnrichment,
} from '@/lib/vision-analyzer'
import { backfillEntities } from '@/lib/rawjson-extractor'
import { backfillArticleContent } from '@/lib/article-extractor'
import { rebuildFts } from '@/lib/fts'

type Stage = 'vision' | 'entities' | 'enrichment' | 'taxonomy' | 'categorize' | 'parallel'

interface CategorizationState {
  status: 'idle' | 'running' | 'stopping'
  stage: Stage | null
  done: number
  total: number
  stageCounts: {
    visionTagged: number
    entitiesExtracted: number
    categoriesGenerated: number
    enriched: number
    categorized: number
  }
  lastError: string | null
  error: string | null
}

// In-memory state for progress tracking across requests
const globalState = globalThis as unknown as {
  categorizationState: CategorizationState
  categorizationAbort: boolean
}

const DEFAULT_STAGE_COUNTS = {
  visionTagged: 0,
  entitiesExtracted: 0,
  categoriesGenerated: 0,
  enriched: 0,
  categorized: 0,
}

if (!globalState.categorizationState) {
  globalState.categorizationState = {
    status: 'idle',
    stage: null,
    done: 0,
    total: 0,
    stageCounts: { ...DEFAULT_STAGE_COUNTS },
    lastError: null,
    error: null,
  }
} else {
  globalState.categorizationState.stageCounts = {
    ...DEFAULT_STAGE_COUNTS,
    ...globalState.categorizationState.stageCounts,
  }
}
if (globalState.categorizationAbort === undefined) {
  globalState.categorizationAbort = false
}

function shouldAbort(): boolean {
  return globalState.categorizationAbort
}

function getState(): CategorizationState {
  return { ...globalState.categorizationState }
}

function setState(update: Partial<CategorizationState>): void {
  globalState.categorizationState = { ...globalState.categorizationState, ...update }
}

export async function GET(): Promise<NextResponse> {
  const state = getState()
  return NextResponse.json({
    status: state.status,
    stage: state.stage,
    done: state.done,
    total: state.total,
    stageCounts: state.stageCounts,
    lastError: state.lastError ? sanitizeErrorText(state.lastError) : null,
    error: state.error ? sanitizeErrorText(state.error) : null,
  })
}

export async function DELETE(): Promise<NextResponse> {
  const state = getState()
  if (state.status !== 'running') {
    return NextResponse.json({ error: 'No pipeline running' }, { status: 409 })
  }
  globalState.categorizationAbort = true
  setState({ status: 'stopping' })
  return NextResponse.json({ stopped: true })
}

const PIPELINE_WORKERS = 5
const CAT_BATCH_SIZE = 12
const LOCAL_PIPELINE_WORKERS = 1
const LOCAL_CAT_BATCH_SIZE = 5
const ERROR_MESSAGE_LIMIT = 1_200

function sanitizeErrorText(message: string): string {
  return message
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function pipelineErrorMessage(err: unknown): string {
  const message = err instanceof Error
    ? err.stack || err.message
    : String(err)
  return sanitizeErrorText(message).slice(0, ERROR_MESSAGE_LIMIT)
}

async function resetAiOutputsForReprocess(bookmarkIds: string[]): Promise<void> {
  const bookmarkWhere = bookmarkIds.length > 0 ? { id: { in: bookmarkIds } } : {}
  const mediaWhere = bookmarkIds.length > 0
    ? { bookmarkId: { in: bookmarkIds }, type: { in: ['photo', 'gif', 'video'] } }
    : { type: { in: ['photo', 'gif', 'video'] } }
  const categoryWhere = bookmarkIds.length > 0 ? { bookmarkId: { in: bookmarkIds } } : {}

  await prisma.$transaction([
    prisma.mediaItem.updateMany({
      where: mediaWhere,
      data: { imageTags: null },
    }),
    prisma.bookmarkCategory.deleteMany({
      where: categoryWhere,
    }),
    prisma.bookmark.updateMany({
      where: bookmarkWhere,
      data: {
        semanticTags: null,
        enrichmentMeta: null,
        enrichedAt: null,
      },
    }),
  ])
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (getState().status === 'running' || getState().status === 'stopping') {
    return NextResponse.json({ error: 'Categorization is already running' }, { status: 409 })
  }

  let body: { bookmarkIds?: string[]; apiKey?: string; force?: boolean } = {}
  try {
    const text = await request.text()
    if (text.trim()) body = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { apiKey, force = false } = body
  const bookmarkIds = Array.isArray(body.bookmarkIds)
    ? body.bookmarkIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []

  if (apiKey && typeof apiKey === 'string' && apiKey.trim() !== '') {
    const currentProvider = await getProvider()
    const keySlot = getApiKeySettingKey(currentProvider)
    await prisma.setting.upsert({
      where: { key: keySlot },
      update: { value: apiKey.trim() },
      create: { key: keySlot, value: apiKey.trim() },
    })
  }

  globalState.categorizationAbort = false

  let total = 0
  try {
    if (bookmarkIds.length > 0) {
      total = bookmarkIds.length
    } else {
      total = await prisma.bookmark.count()
    }
  } catch {
    total = 0
  }

  setState({
    status: 'running',
    stage: 'entities',
    done: 0,
    total,
    stageCounts: { ...DEFAULT_STAGE_COUNTS },
    lastError: null,
    error: null,
  })

  const provider = await getProvider()
  const pipelineWorkerCount = provider === 'local' ? LOCAL_PIPELINE_WORKERS : PIPELINE_WORKERS
  const categoryBatchSize = provider === 'local' ? LOCAL_CAT_BATCH_SIZE : CAT_BATCH_SIZE
  const keyName = getApiKeySettingKey(provider)
  const dbApiKey =
    (await prisma.setting.findUnique({ where: { key: keyName } }))?.value?.trim() || ''

  void (async () => {
    const counts = { ...DEFAULT_STAGE_COUNTS }
    let pipelineFailed = false

    try {
      let client: AIClient | null = null
      try {
        client = await resolveAIClient({ dbKey: dbApiKey })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (provider === 'local') {
          throw new Error(`Local AI client unavailable: ${message}`)
        }
        // SDK client not available — CLI path may still work (e.g. ChatGPT OAuth via codex exec)
        console.warn('No SDK client available — will rely on CLI path')
      }

        await seedDefaultCategories()

        if (force) {
          await resetAiOutputsForReprocess(bookmarkIds)
        }

        // Stage 1: Entity extraction (free, fast — no API calls)
        if (!shouldAbort()) {
          setState({ stage: 'entities' })
          counts.entitiesExtracted = await backfillEntities((n) => {
            counts.entitiesExtracted = n
            setState({ stageCounts: { ...counts } })
          }, shouldAbort).catch((err) => {
            console.error('Entity extraction error:', err)
            return counts.entitiesExtracted
          })
          setState({ stageCounts: { ...counts } })
        }

        // Linked article extraction: fetch cleaned article text before AI enrichment/categorization.
        if (!shouldAbort()) {
          await backfillArticleContent(undefined, shouldAbort).catch((err) => {
            console.error('Article extraction error:', err)
            return 0
          })
        }

        let bookmarkIdsToProcess: string[] = []
        if (!shouldAbort()) {
          if (bookmarkIds.length > 0 || force) {
            const rows = await prisma.bookmark.findMany({
              where: bookmarkIds.length > 0 ? { id: { in: bookmarkIds } } : {},
              select: { id: true },
              orderBy: { id: 'asc' },
            })
            bookmarkIdsToProcess = rows.map((bookmark) => bookmark.id)
          } else {
            const rows = await prisma.bookmark.findMany({
              where: { enrichedAt: null },
              select: { id: true },
              orderBy: { id: 'asc' },
            })
            bookmarkIdsToProcess = rows.map((bookmark) => bookmark.id)
          }
        }

        // Stage 2: Parallel vision + enrichment. Categorization waits until taxonomy discovery is complete.
        if (!shouldAbort() && bookmarkIdsToProcess.length > 0) {

          const runTotal = bookmarkIdsToProcess.length
          setState({ stage: 'parallel', done: 0, total: runTotal, stageCounts: { ...counts } })

          const model = await getActiveModel()
          let processedCount = 0

          async function processBookmark(bookmarkId: string): Promise<void> {
            if (shouldAbort()) return

            const bm = await prisma.bookmark.findUnique({
              where: { id: bookmarkId },
              select: {
                id: true,
                text: true,
                semanticTags: true,
                entities: true,
                mediaItems: {
                  where: { type: { in: ['photo', 'gif', 'video'] } },
                  select: { id: true, url: true, thumbnailUrl: true, type: true, imageTags: true },
                },
              },
            })
            if (!bm) return

            // Vision: analyze any untagged media items (SDK or CLI)
            let anyVisionRan = false
            for (const media of bm.mediaItems) {
              if (shouldAbort()) return
              if (media.imageTags !== null) continue
              try {
                await analyzeItem(
                  { id: media.id, url: media.url, thumbnailUrl: media.thumbnailUrl, type: media.type },
                  client,
                  model,
                )
                anyVisionRan = true
                counts.visionTagged++
                setState({ stageCounts: { ...counts } })
              } catch (err) {
                console.warn('[parallel] vision failed for', media.id, err instanceof Error ? err.message : err)
              }
            }

            // Enrichment: generate semantic tags if not already done
            if (!bm.semanticTags) {
              // Re-fetch image tags from DB after vision (or use initial fetch if no vision ran)
              const imageTags = anyVisionRan
                ? (
                    await prisma.mediaItem.findMany({
                      where: { bookmarkId: bm.id, type: { in: ['photo', 'gif', 'video'] } },
                      select: { imageTags: true },
                    })
                  )
                    .map((m) => m.imageTags)
                    .filter((t): t is string => t !== null && t !== '' && t !== '{}')
                : bm.mediaItems
                    .map((m) => m.imageTags)
                    .filter((t): t is string => t !== null && t !== '' && t !== '{}')

              if (imageTags.length === 0 && bm.text.length < 20) {
                // Trivial bookmark — skip enrichment
                await prisma.bookmark.update({ where: { id: bm.id }, data: { semanticTags: '[]' } })
              } else {
                let entities: BookmarkForEnrichment['entities'] = undefined
                if (bm.entities) {
                  try {
                    entities = JSON.parse(bm.entities) as BookmarkForEnrichment['entities']
                  } catch { /* ignore */ }
                }
                try {
                  const results = await enrichBatchSemanticTags(
                    [{ id: bm.id, text: bm.text, imageTags, entities }],
                    client,
                  )
                  const result = results[0]
                  if (result?.tags.length) {
                    await prisma.bookmark.update({
                      where: { id: bm.id },
                      data: {
                        semanticTags: JSON.stringify(result.tags),
                        enrichmentMeta: JSON.stringify({
                          sentiment: result.sentiment,
                          people: result.people,
                          companies: result.companies,
                        }),
                      },
                    })
                    counts.enriched++
                    setState({ stageCounts: { ...counts } })
                  }
                } catch (err) {
                  console.warn('[parallel] enrichment failed for', bm.id, err instanceof Error ? err.message : err)
                }
              }
            }

            processedCount++
            setState({ done: processedCount, stageCounts: { ...counts } })
          }

          const tasks = bookmarkIdsToProcess.map((id) => () => processBookmark(id))
          await runWithConcurrency(tasks, pipelineWorkerCount)
        }

        // Stage 3: Discover generated collections from the actual bookmark corpus.
        if (!shouldAbort()) {
          const taxonomyBookmarkIds = bookmarkIds.length > 0 ? bookmarkIds : undefined
          const taxonomyTotal = taxonomyBookmarkIds?.length ?? await prisma.bookmark.count()
          setState({ stage: 'taxonomy', done: 0, total: taxonomyTotal, stageCounts: { ...counts } })
          const discovered = await discoverCategoriesFromBookmarks(client, {
            bookmarkIds: taxonomyBookmarkIds,
            shouldAbort,
            onProgress: (done, total) => {
              setState({ stage: 'taxonomy', done, total, stageCounts: { ...counts } })
            },
          })
          counts.categoriesGenerated = discovered.length
          setState({ stageCounts: { ...counts } })
        }

        // Stage 4: Categorize against broad defaults + generated collections.
        if (!shouldAbort()) {
          const idsToCategorize = bookmarkIds.length > 0
            ? bookmarkIds
            : (await prisma.bookmark.findMany({
                select: { id: true },
                orderBy: { id: 'asc' },
              })).map((bookmark) => bookmark.id)

          setState({ stage: 'categorize', done: 0, total: idsToCategorize.length, stageCounts: { ...counts } })

          const dbCategories = await prisma.category.findMany({
            select: { slug: true, name: true, description: true },
          })
          const allSlugs = dbCategories.map((category) => category.slug)
          const categoryDescriptions = Object.fromEntries(
            dbCategories.map((category) => [category.slug, category.description?.trim() || category.name]),
          )

          let categorizedDone = 0
          for (let index = 0; index < idsToCategorize.length; index += categoryBatchSize) {
            if (shouldAbort()) break
            const ids = idsToCategorize.slice(index, index + categoryBatchSize)
            const rows = await prisma.bookmark.findMany({
              where: { id: { in: ids } },
              select: BOOKMARK_SELECT,
            })
            const batch = rows.map(mapBookmarkForCategorization)
            try {
              const results = await categorizeBatch(batch, client, categoryDescriptions, allSlugs)
              const written = await writeCategoryResults(results)
              counts.categorized += written
            } catch (catErr) {
              const message = pipelineErrorMessage(catErr)
              pipelineFailed = true
              setState({ lastError: message, stageCounts: { ...counts } })
              console.error('[categorize] batch error:', catErr)
            }
            categorizedDone += rows.length
            setState({
              done: Math.min(categorizedDone, idsToCategorize.length),
              stageCounts: { ...counts },
            })
          }
        }
    } catch (err) {
      console.error('Pipeline error:', err)
      pipelineFailed = true
      setState({ lastError: pipelineErrorMessage(err) })
    }

    if (!shouldAbort() && !pipelineFailed) {
      await rebuildFts().catch((err) => console.error('FTS rebuild error:', err))
    }

    if (pipelineFailed) {
      const message = getState().lastError ?? 'Pipeline failed'
      throw new Error(message)
    }
  })()
    .then(async () => {
      const wasStopped = globalState.categorizationAbort
      const state = getState()
      globalState.categorizationAbort = false
      setState({
        status: 'idle',
        stage: null,
        done: wasStopped ? state.done : state.total,
        total: state.total,
        error: wasStopped ? 'Stopped by user' : null,
      })

      // Fire webhook if configured and pipeline wasn't stopped
      if (!wasStopped) {
        try {
          const webhookUrl = await getWebhookUrl()
          if (webhookUrl) {
            const state = getState()
            const recentBookmarks = await prisma.bookmark.findMany({
              where: { enrichedAt: { not: null } },
              take: 200,
              orderBy: { enrichedAt: 'desc' },
              include: {
                mediaItems: true,
                categories: {
                  include: { category: { select: { name: true, slug: true, color: true } } },
                },
              },
            })
            const payload = {
              event: 'categorization.complete',
              timestamp: new Date().toISOString(),
              stats: {
                total: state.total,
                categorized: state.stageCounts.categorized,
                failed: Math.max(0, state.total - state.stageCounts.categorized),
              },
              bookmarks: recentBookmarks.map((b) => ({
                tweetId: b.tweetId,
                text: b.text,
                authorHandle: b.authorHandle,
                authorName: b.authorName,
                source: b.source,
                tweetCreatedAt: b.tweetCreatedAt?.toISOString() ?? null,
                categories: b.categories.map((bc) => ({
                  name: bc.category.name,
                  slug: bc.category.slug,
                  color: bc.category.color,
                  confidence: bc.confidence,
                })),
                mediaItems: b.mediaItems.map((m) => ({
                  type: m.type,
                  url: m.url,
                  thumbnailUrl: m.thumbnailUrl,
                })),
                semanticTags: b.semanticTags ? JSON.parse(b.semanticTags) : [],
              })),
            }
            await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            })
            console.log(`Webhook fired to ${webhookUrl} with ${recentBookmarks.length} bookmarks`)
          }
        } catch (err) {
          console.error('Webhook error:', err)
        }
      }
    })
    .catch((err) => {
      globalState.categorizationAbort = false
      console.error('Categorization pipeline error:', err)
      const state = getState()
      setState({
        status: 'idle',
        stage: null,
        done: state.done,
        total: state.total,
        error: err instanceof Error ? err.message : String(err),
      })
    })

  return NextResponse.json({ status: 'started', total })
}
