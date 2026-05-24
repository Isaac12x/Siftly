import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { parseBookmarksJson, type ParsedBookmark } from '@/lib/parser'
import { mapWithConcurrency, planImportBookmarks } from '@/lib/import-optimizer'
import {
  type ArticleImportFields,
  buildArticleImportFields,
  extractArticleUrlsFromRawJson,
  extractEmbeddedArticleContentFromRawJson,
  fetchFirstArticleContent,
} from '@/lib/article-extractor'

const IMPORT_PREPARE_CONCURRENCY = 6
const IMPORT_PREPARE_CHUNK_SIZE = 100

interface PreparedBookmarkImport {
  bookmark: ParsedBookmark
  articleFields: ArticleImportFields
}

async function prepareBookmarkImport(bookmark: ParsedBookmark): Promise<PreparedBookmarkImport> {
  const articleUrls = Array.from(new Set([
    bookmark.articleUrl,
    ...bookmark.urls,
    ...extractArticleUrlsFromRawJson(bookmark.rawJson),
  ].filter((url): url is string => Boolean(url))))
  const existingArticle = bookmark.articleContent
    ? { url: bookmark.articleUrl ?? articleUrls[0] ?? '', content: bookmark.articleContent }
    : null
  const embeddedArticle = extractEmbeddedArticleContentFromRawJson(bookmark.rawJson)
  const article = existingArticle ?? embeddedArticle ?? await fetchFirstArticleContent(articleUrls)

  return {
    bookmark,
    articleFields: buildArticleImportFields(articleUrls, article),
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Failed to parse form data' }, { status: 400 })
  }

  const sourceParam = (formData.get('source') as string | null)?.trim()
  const file = formData.get('file')
  if (!file || !(file instanceof Blob)) {
    return NextResponse.json(
      { error: 'Missing required field: file' },
      { status: 400 }
    )
  }

  const filename =
    file instanceof File ? file.name : 'bookmarks.json'

  let jsonString: string
  try {
    jsonString = await file.text()
  } catch {
    return NextResponse.json({ error: 'Failed to read file content' }, { status: 400 })
  }

  // Create an import job to track progress
  const importJob = await prisma.importJob.create({
    data: {
      filename,
      status: 'processing',
      totalCount: 0,
      processedCount: 0,
    },
  })

  let parsedBookmarks: ParsedBookmark[]
  try {
    parsedBookmarks = parseBookmarksJson(jsonString)
  } catch (err) {
    await prisma.importJob.update({
      where: { id: importJob.id },
      data: {
        status: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    })
    return NextResponse.json(
      { error: `Failed to parse bookmarks JSON: ${err instanceof Error ? err.message : String(err)}` },
      { status: 422 }
    )
  }

  // Determine source: formData param > JSON field > default "bookmark"
  let jsonSource: string | undefined
  try {
    const parsed = JSON.parse(jsonString)
    if (typeof parsed?.source === 'string') jsonSource = parsed.source
  } catch { /* already parsed above */ }
  const source = (sourceParam === 'like' || sourceParam === 'bookmark')
    ? sourceParam
    : (jsonSource === 'like' ? 'like' : 'bookmark')

  await prisma.importJob.update({
    where: { id: importJob.id },
    data: { totalCount: parsedBookmarks.length },
  })

  let importedCount = 0
  let failedCount = 0
  let firstError: string | null = null

  const tweetIds = Array.from(new Set(parsedBookmarks.map((bookmark) => bookmark.tweetId)))
  const existingBookmarks = tweetIds.length > 0
    ? await prisma.bookmark.findMany({
        where: { tweetId: { in: tweetIds } },
        select: { tweetId: true },
      })
    : []
  const importPlan = planImportBookmarks(
    parsedBookmarks,
    new Set(existingBookmarks.map((bookmark) => bookmark.tweetId)),
  )
  const skippedCount = importPlan.skippedCount
  for (let index = 0; index < importPlan.bookmarks.length; index += IMPORT_PREPARE_CHUNK_SIZE) {
    const preparedBookmarks = await mapWithConcurrency(
      importPlan.bookmarks.slice(index, index + IMPORT_PREPARE_CHUNK_SIZE),
      IMPORT_PREPARE_CONCURRENCY,
      (bookmark) => prepareBookmarkImport(bookmark),
    )

    for (const { bookmark, articleFields } of preparedBookmarks) {
      try {
        await prisma.bookmark.create({
          data: {
            tweetId: bookmark.tweetId,
            text: bookmark.text,
            authorHandle: bookmark.authorHandle,
            authorName: bookmark.authorName,
            tweetCreatedAt: bookmark.tweetCreatedAt,
            rawJson: bookmark.rawJson,
            ...articleFields,
            source,
            ...(bookmark.media.length > 0
              ? {
                  mediaItems: {
                    create: bookmark.media.map((m) => ({
                      type: m.type,
                      url: m.url,
                      thumbnailUrl: m.thumbnailUrl ?? null,
                    })),
                  },
                }
              : {}),
          },
        })

        importedCount++
      } catch (err) {
        console.error(`Failed to import tweet ${bookmark.tweetId}:`, err)
        failedCount++
        firstError ??= err instanceof Error ? err.message : String(err)
      }
    }
  }

  const processedCount = importedCount + skippedCount + failedCount
  const errorMessage = failedCount > 0
    ? `Failed to import ${failedCount} bookmark${failedCount === 1 ? '' : 's'}${firstError ? `: ${firstError}` : ''}`
    : null

  await prisma.importJob.update({
    where: { id: importJob.id },
    data: {
      status: failedCount > 0 ? 'error' : 'done',
      processedCount,
      errorMessage,
    },
  })

  if (failedCount > 0) {
    return NextResponse.json({
      jobId: importJob.id,
      imported: importedCount,
      skipped: skippedCount,
      failed: failedCount,
      parsed: parsedBookmarks.length,
      error: errorMessage,
    }, { status: 500 })
  }

  return NextResponse.json({
    jobId: importJob.id,
    imported: importedCount,
    skipped: skippedCount,
    failed: failedCount,
    parsed: parsedBookmarks.length,
  })
}
