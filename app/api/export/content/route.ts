import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'

const DEFAULT_PAGE = 1
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

function parseIntParam(value: string | null, defaultValue: number): number {
  if (!value) return defaultValue
  const parsed = parseInt(value, 10)
  return isNaN(parsed) || parsed < 1 ? defaultValue : parsed
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)

  const page = parseIntParam(searchParams.get('page'), DEFAULT_PAGE)
  const limit = Math.min(parseIntParam(searchParams.get('limit'), DEFAULT_LIMIT), MAX_LIMIT)
  const skip = (page - 1) * limit

  const source = searchParams.get('source')?.trim() ?? ''
  const categorySlug = searchParams.get('category')?.trim() ?? ''
  const sortParam = searchParams.get('sort')?.trim() ?? 'newest'
  const since = searchParams.get('since')?.trim() ?? ''
  const enriched = searchParams.get('enriched')?.trim() ?? ''

  const orderDir = sortParam === 'oldest' ? ('asc' as const) : ('desc' as const)
  const where: Record<string, unknown> = {}

  if (source === 'bookmark' || source === 'like') {
    where.source = source
  }

  if (categorySlug) {
    where.categories = { some: { category: { slug: categorySlug } } }
  }

  if (since) {
    const sinceDate = new Date(since)
    if (!isNaN(sinceDate.getTime())) {
      where.importedAt = { gte: sinceDate }
    }
  }

  if (enriched === 'true') {
    where.enrichedAt = { not: null }
  } else if (enriched === 'false') {
    where.enrichedAt = null
  }

  try {
    const [bookmarks, total] = await Promise.all([
      prisma.bookmark.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ tweetCreatedAt: orderDir }, { importedAt: orderDir }],
        include: {
          mediaItems: true,
          categories: {
            include: {
              category: { select: { name: true, slug: true, color: true } },
            },
          },
        },
      }),
      prisma.bookmark.count({ where }),
    ])

    const data = bookmarks.map((b) => ({
      tweetId: b.tweetId,
      text: b.text,
      authorHandle: b.authorHandle,
      authorName: b.authorName,
      source: b.source,
      tweetCreatedAt: b.tweetCreatedAt?.toISOString() ?? null,
      importedAt: b.importedAt.toISOString(),
      enrichedAt: b.enrichedAt?.toISOString() ?? null,
      semanticTags: b.semanticTags ? JSON.parse(b.semanticTags) : [],
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
    }))

    return NextResponse.json({
      data,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    })
  } catch (err) {
    console.error('Export content error:', err)
    return NextResponse.json(
      { error: `Failed to export content: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}
