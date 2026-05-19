import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@/app/generated/prisma/client'
import prisma from '@/lib/db'
import {
  extractBookmarkEngagement,
  matchesEngagementBand,
} from '@/lib/engagement'
import { ftsSearch } from '@/lib/fts'
import { extractKeywords } from '@/lib/search-utils'

const DEFAULT_PAGE = 1
const DEFAULT_LIMIT = 24
const MAX_LIMIT = 100

const BOOKMARK_INCLUDE = {
  mediaItems: true,
  categories: {
    include: {
      category: {
        select: {
          id: true,
          name: true,
          slug: true,
          color: true,
        },
      },
    },
  },
} as const

type BookmarkRecord = Prisma.BookmarkGetPayload<{
  include: typeof BOOKMARK_INCLUDE
}>

function parseIntParam(value: string | null, defaultValue: number): number {
  if (!value) return defaultValue
  const parsed = parseInt(value, 10)
  return isNaN(parsed) || parsed < 1 ? defaultValue : parsed
}

function buildSearchConditions(query: string): Prisma.BookmarkWhereInput[] {
  const terms = Array.from(new Set([query, ...extractKeywords(query)]))
    .map((term) => term.trim())
    .filter(Boolean)

  return terms.flatMap((term) => [
    { text: { contains: term } },
    { articleContent: { contains: term } },
    { authorHandle: { contains: term.replace(/^@+/, '') } },
    { authorName: { contains: term } },
    { semanticTags: { contains: term } },
    { entities: { contains: term } },
    {
      categories: {
        some: {
          category: {
            OR: [
              { name: { contains: term } },
              { slug: { contains: term.toLowerCase().replace(/\s+/g, '-') } },
            ],
          },
        },
      },
    },
    {
      mediaItems: {
        some: { imageTags: { contains: term } },
      },
    },
  ])
}

function compareBookmarks(
  left: BookmarkRecord,
  right: BookmarkRecord,
  orderDir: 'asc' | 'desc',
  rankMap: Map<string, number>,
): number {
  const leftRank = rankMap.get(left.id) ?? Number.MAX_SAFE_INTEGER
  const rightRank = rankMap.get(right.id) ?? Number.MAX_SAFE_INTEGER

  if (leftRank !== rightRank) return leftRank - rightRank

  const leftTime = new Date(left.tweetCreatedAt ?? left.importedAt).getTime()
  const rightTime = new Date(right.tweetCreatedAt ?? right.importedAt).getTime()
  return orderDir === 'asc' ? leftTime - rightTime : rightTime - leftTime
}

export async function DELETE(): Promise<NextResponse> {
  try {
    // Delete media items and category links first (cascade), then bookmarks
    await prisma.$transaction([
      prisma.bookmarkCategory.deleteMany({}),
      prisma.mediaItem.deleteMany({}),
      prisma.bookmark.deleteMany({}),
      prisma.category.deleteMany({}),
    ])
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Clear bookmarks error:', err)
    return NextResponse.json(
      { error: `Failed to clear bookmarks: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)

  const q = searchParams.get('q')?.trim() ?? ''
  const source = searchParams.get('source')?.trim() ?? ''
  const categorySlug = searchParams.get('category')?.trim() ?? ''
  const mediaType = searchParams.get('mediaType')?.trim() ?? ''
  const likesBand = searchParams.get('likesBand')?.trim() ?? ''
  const viewsBand = searchParams.get('viewsBand')?.trim() ?? ''
  const uncategorized = searchParams.get('uncategorized') === 'true'
  const sortParam = searchParams.get('sort')?.trim() ?? 'newest'
  const page = parseIntParam(searchParams.get('page'), DEFAULT_PAGE)
  const limit = Math.min(parseIntParam(searchParams.get('limit'), DEFAULT_LIMIT), MAX_LIMIT)
  const skip = (page - 1) * limit
  const orderDir: 'asc' | 'desc' = sortParam === 'oldest' ? 'asc' : 'desc'
  const needsEngagementFiltering = !!(likesBand || viewsBand)
  const keywords = q ? extractKeywords(q) : []
  const ftsIds = keywords.length > 0 ? await ftsSearch(keywords) : []
  const rankMap = new Map(ftsIds.map((id, index) => [id, index]))

  const andConditions: Prisma.BookmarkWhereInput[] = []

  if (source === 'bookmark' || source === 'like') {
    andConditions.push({ source })
  }

  if (q) {
    const fallbackConditions = buildSearchConditions(q)
    const searchConditions: Prisma.BookmarkWhereInput[] = []

    if (ftsIds.length > 0) {
      searchConditions.push({ id: { in: ftsIds } })
    }

    searchConditions.push(...fallbackConditions)

    andConditions.push({ OR: searchConditions })
  }

  if (uncategorized) {
    andConditions.push({ categories: { none: {} } })
  } else if (categorySlug) {
    andConditions.push({
      categories: {
        some: {
          category: { slug: categorySlug },
        },
      },
    })
  }

  if (mediaType === 'photo' || mediaType === 'video') {
    andConditions.push({ mediaItems: { some: { type: mediaType } } })
  }

  const where: Prisma.BookmarkWhereInput = andConditions.length > 0
    ? { AND: andConditions }
    : {}

  try {
    const query = {
      where,
      orderBy: [{ tweetCreatedAt: orderDir }, { importedAt: orderDir }],
      include: BOOKMARK_INCLUDE,
    }

    let total = 0
    let pageRows: Array<{
      bookmark: BookmarkRecord
      engagement: ReturnType<typeof extractBookmarkEngagement>
    }> = []

    if (needsEngagementFiltering || q) {
      const bookmarkRows = await prisma.bookmark.findMany(query)
      const rankedBookmarks = q
        ? [...bookmarkRows].sort((left, right) => compareBookmarks(left, right, orderDir, rankMap))
        : bookmarkRows

      const bookmarksWithEngagement = rankedBookmarks
        .map((bookmark) => ({
          bookmark,
          engagement: extractBookmarkEngagement(bookmark.rawJson),
        }))
        .filter(({ engagement }) =>
          matchesEngagementBand('likes', engagement.likes, likesBand) &&
          matchesEngagementBand('views', engagement.views, viewsBand),
        )

      total = bookmarksWithEngagement.length
      pageRows = bookmarksWithEngagement.slice(skip, skip + limit)
    } else {
      const [bookmarkRows, totalCount] = await Promise.all([
        prisma.bookmark.findMany({
          ...query,
          skip,
          take: limit,
        }),
        prisma.bookmark.count({ where }),
      ])

      total = totalCount
      pageRows = bookmarkRows.map((bookmark) => ({
        bookmark,
        engagement: extractBookmarkEngagement(bookmark.rawJson),
      }))
    }

    const formatted = pageRows.map(({ bookmark, engagement }) => ({
      id: bookmark.id,
      tweetId: bookmark.tweetId,
      text: bookmark.text,
      articleUrl: bookmark.articleUrl,
      articleContent: bookmark.articleContent,
      authorHandle: bookmark.authorHandle,
      authorName: bookmark.authorName,
      source: bookmark.source,
      tweetCreatedAt: bookmark.tweetCreatedAt?.toISOString() ?? null,
      importedAt: bookmark.importedAt.toISOString(),
      engagement,
      mediaItems: bookmark.mediaItems.map((m) => ({
        id: m.id,
        type: m.type,
        url: m.url,
        thumbnailUrl: m.thumbnailUrl,
      })),
      categories: bookmark.categories.map((bc) => ({
        id: bc.category.id,
        name: bc.category.name,
        slug: bc.category.slug,
        color: bc.category.color,
        confidence: bc.confidence,
      })),
    }))

    return NextResponse.json({
      bookmarks: formatted,
      total,
      page,
      limit,
    })
  } catch (err) {
    console.error('Bookmarks fetch error:', err)
    return NextResponse.json(
      { error: `Failed to fetch bookmarks: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}
