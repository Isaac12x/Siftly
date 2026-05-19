import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { buildArticleImportFields, fetchFirstArticleContent } from '@/lib/article-extractor'

const TWEET_FIELDS = 'created_at,author_id,text,entities,attachments'
const EXPANSIONS = 'author_id,attachments.media_keys'
const USER_FIELDS = 'name,username,profile_image_url'
const MEDIA_FIELDS = 'type,url,preview_image_url,variants'

const CURSOR_KEY = 'x_oauth_fetch_cursor'

/** Refresh the access token using the stored refresh token */
async function refreshAccessToken(): Promise<string | null> {
  const [clientId, clientSecret, refreshToken] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'x_oauth_client_id' } }),
    prisma.setting.findUnique({ where: { key: 'x_oauth_client_secret' } }),
    prisma.setting.findUnique({ where: { key: 'x_oauth_refresh_token' } }),
  ])

  if (!clientId?.value || !clientSecret?.value || !refreshToken?.value) return null

  const res = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId.value}:${clientSecret.value}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken.value,
    }),
  })

  if (!res.ok) {
    console.error('[x-oauth] Token refresh failed:', await res.text())
    return null
  }

  const data = await res.json()

  const updates = [
    { key: 'x_oauth_access_token', value: data.access_token },
    ...(data.refresh_token ? [{ key: 'x_oauth_refresh_token', value: data.refresh_token }] : []),
  ]

  await Promise.all(
    updates.map((s) =>
      prisma.setting.upsert({
        where: { key: s.key },
        update: { value: s.value },
        create: { key: s.key, value: s.value },
      }),
    ),
  )

  return data.access_token
}

interface V2Tweet {
  id: string
  text: string
  author_id?: string
  created_at?: string
  entities?: {
    urls?: { expanded_url?: string; unwound_url?: string; url?: string; display_url?: string }[]
    hashtags?: { tag: string }[]
    mentions?: { username: string }[]
  }
  attachments?: { media_keys?: string[] }
}

interface V2User {
  id: string
  name: string
  username: string
}

interface V2Media {
  media_key: string
  type: string
  url?: string
  preview_image_url?: string
  variants?: { bit_rate?: number; content_type?: string; url: string }[]
}

interface V2Response {
  data?: V2Tweet[]
  includes?: { users?: V2User[]; media?: V2Media[] }
  meta?: { next_token?: string; result_count?: number }
}

class RateLimitError extends Error {
  resetAt: number | null
  reason: 'rate_limit' | 'usage_cap'
  constructor(resetAt: number | null, reason: 'rate_limit' | 'usage_cap' = 'rate_limit') {
    const msg = reason === 'usage_cap'
      ? 'X API usage cap exceeded — your plan may have run out of credits'
      : resetAt
        ? `Rate limited. Resets at ${new Date(resetAt * 1000).toLocaleTimeString()}`
        : 'Rate limited by X API'
    super(msg)
    this.name = 'RateLimitError'
    this.resetAt = resetAt
    this.reason = reason
  }
}

async function fetchBookmarksPage(
  accessToken: string,
  userId: string,
  paginationToken?: string,
): Promise<V2Response> {
  const params = new URLSearchParams({
    'tweet.fields': TWEET_FIELDS,
    expansions: EXPANSIONS,
    'user.fields': USER_FIELDS,
    'media.fields': MEDIA_FIELDS,
    max_results: '100',
  })
  if (paginationToken) params.set('pagination_token', paginationToken)

  const res = await fetch(
    `https://api.twitter.com/2/users/${userId}/bookmarks?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )

  if (res.status === 429) {
    const resetHeader = res.headers.get('x-rate-limit-reset')
    throw new RateLimitError(resetHeader ? parseInt(resetHeader, 10) : null, 'rate_limit')
  }

  // 403 with usage cap message = credits exhausted
  if (res.status === 403) {
    const text = await res.text()
    const isUsageCap = text.includes('Usage Cap') || text.includes('usage') || text.includes('cap')
    if (isUsageCap) {
      throw new RateLimitError(null, 'usage_cap')
    }
    throw new Error(`X API 403: ${text.slice(0, 300)}`)
  }

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`X API ${res.status}: ${text.slice(0, 300)}`)
  }

  return res.json()
}

function bestVideoUrl(variants?: V2Media['variants']): string | null {
  if (!variants?.length) return null
  const mp4s = variants.filter((v) => v.content_type === 'video/mp4' && v.bit_rate != null)
  if (mp4s.length === 0) return variants[0]?.url ?? null
  mp4s.sort((a, b) => (b.bit_rate ?? 0) - (a.bit_rate ?? 0))
  return mp4s[0].url
}

async function saveCursor(cursor: string | null) {
  if (cursor) {
    await prisma.setting.upsert({
      where: { key: CURSOR_KEY },
      update: { value: cursor },
      create: { key: CURSOR_KEY, value: cursor },
    })
  } else {
    await prisma.setting.deleteMany({ where: { key: CURSOR_KEY } })
  }
}

export async function POST(request: NextRequest) {
  let body: { maxPages?: number; reset?: boolean } = {}
  try {
    body = await request.json()
  } catch {
    // default
  }

  // 0 = unlimited (fetch all), otherwise respect the caller's limit
  const maxPages = body.maxPages ?? 0

  try {
    let accessToken = (
      await prisma.setting.findUnique({ where: { key: 'x_oauth_access_token' } })
    )?.value
    const userId = (
      await prisma.setting.findUnique({ where: { key: 'x_oauth_user_id' } })
    )?.value

    if (!accessToken || !userId) {
      return NextResponse.json(
        { error: 'Not connected. Authorize with X first.' },
        { status: 401 },
      )
    }

    // Resume from saved cursor, or start fresh if reset requested
    let nextToken: string | undefined
    if (body.reset) {
      await saveCursor(null)
    } else {
      const saved = await prisma.setting.findUnique({ where: { key: CURSOR_KEY } })
      if (saved?.value) nextToken = saved.value
    }

    const resuming = !!nextToken
    let imported = 0
    let skipped = 0
    let total = 0

    for (let page = 0; maxPages === 0 || page < maxPages; page++) {
      let data: V2Response

      console.log(`[x-oauth] Page ${page + 1}: fetching (cursor: ${nextToken ? nextToken.slice(0, 20) + '...' : 'none'})`)

      try {
        data = await fetchBookmarksPage(accessToken, userId, nextToken)
      } catch (err) {
        // Rate limited — save cursor for resume and return partial results
        if (err instanceof RateLimitError) {
          await saveCursor(nextToken ?? null)

          return NextResponse.json({
            imported,
            skipped,
            total,
            rateLimited: true,
            rateLimitReason: err.reason,
            resetAt: err.resetAt,
            resumable: true,
          })
        }

        // Try refreshing token once on 401
        if (err instanceof Error && err.message.includes('401') && page === 0) {
          const newToken = await refreshAccessToken()
          if (!newToken) {
            return NextResponse.json(
              { error: 'Token expired. Please reconnect your X account.' },
              { status: 401 },
            )
          }
          accessToken = newToken
          try {
            data = await fetchBookmarksPage(accessToken, userId, nextToken)
          } catch (retryErr) {
            if (retryErr instanceof RateLimitError) {
              await saveCursor(nextToken ?? null)
              return NextResponse.json({
                imported,
                skipped,
                total,
                rateLimited: true,
                rateLimitReason: retryErr.reason,
                resetAt: retryErr.resetAt,
                resumable: true,
              })
            }
            throw retryErr
          }
        } else {
          throw err
        }
      }

      const tweets = data.data ?? []
      total += tweets.length
      console.log(`[x-oauth] Page ${page + 1}: got ${tweets.length} tweets, next_token: ${data.meta?.next_token ? 'yes' : 'NO — end of results'}`)
      if (tweets.length === 0) break

      // Build lookup maps
      const userMap = new Map<string, V2User>()
      for (const u of data.includes?.users ?? []) userMap.set(u.id, u)

      const mediaMap = new Map<string, V2Media>()
      for (const m of data.includes?.media ?? []) mediaMap.set(m.media_key, m)

      // Import each tweet
      for (const tweet of tweets) {
        try {
          const exists = await prisma.bookmark.findUnique({
            where: { tweetId: tweet.id },
            select: { id: true },
          })

          if (exists) {
            skipped++
            continue
          }

          const author = tweet.author_id ? userMap.get(tweet.author_id) : undefined

          let parsedDate: Date | null = null
          if (tweet.created_at) {
            const d = new Date(tweet.created_at)
            if (!isNaN(d.getTime())) parsedDate = d
          }

          const articleUrls = (tweet.entities?.urls ?? [])
            .map((u) => u.expanded_url ?? u.unwound_url ?? u.url ?? '')
            .filter(Boolean)
          const article = await fetchFirstArticleContent(articleUrls)
          const articleFields = buildArticleImportFields(articleUrls, article)

          const created = await prisma.bookmark.create({
            data: {
              tweetId: tweet.id,
              text: tweet.text,
              authorHandle: author?.username ?? 'unknown',
              authorName: author?.name ?? 'Unknown',
              tweetCreatedAt: parsedDate,
              rawJson: JSON.stringify(tweet),
              ...articleFields,
            },
          })

          // Import media
          const mediaKeys = tweet.attachments?.media_keys ?? []
          const mediaItems: { bookmarkId: string; type: string; url: string; thumbnailUrl: string | null }[] = []

          for (const key of mediaKeys) {
            const m = mediaMap.get(key)
            if (!m) continue

            let url = m.url ?? ''
            let thumbnailUrl: string | null = m.preview_image_url ?? null

            if (m.type === 'video' || m.type === 'animated_gif') {
              const videoUrl = bestVideoUrl(m.variants)
              if (videoUrl) url = videoUrl
              if (!thumbnailUrl && m.preview_image_url) thumbnailUrl = m.preview_image_url
            }

            if (url) {
              mediaItems.push({
                bookmarkId: created.id,
                type: m.type === 'animated_gif' ? 'gif' : m.type,
                url,
                thumbnailUrl,
              })
            }
          }

          if (mediaItems.length > 0) {
            await prisma.mediaItem.createMany({ data: mediaItems })
          }

          imported++
        } catch (err) {
          console.error(`[x-oauth] Failed to import tweet ${tweet.id}:`, err instanceof Error ? err.message : err)
        }
      }

      nextToken = data.meta?.next_token
      if (!nextToken) break
    }

    // Pagination complete — clear saved cursor
    console.log(`[x-oauth] Fetch complete: ${imported} imported, ${skipped} skipped, ${total} total across all pages`)
    await saveCursor(null)

    // Update last sync timestamp
    if (imported > 0 || skipped > 0) {
      await prisma.setting.upsert({
        where: { key: 'x_last_sync' },
        update: { value: new Date().toISOString() },
        create: { key: 'x_last_sync', value: new Date().toISOString() },
      })
    }

    return NextResponse.json({ imported, skipped, total, resuming })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Fetch failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
