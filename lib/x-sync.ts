import { schedule as cronSchedule, type ScheduledTask } from 'node-cron'
import prisma from '@/lib/db'
import { fetchPage, parsePage, importTweets } from '@/lib/twitter-api'

// ── Sync (headless: auth_token + ct0) ────────────────────────────────────────

export async function syncBookmarks(
  authToken: string,
  ct0: string,
): Promise<{ imported: number; skipped: number }> {
  if (syncing) throw new Error('A sync is already in progress')
  syncing = true

  try {
    let imported = 0
    let skipped = 0
    let cursor: string | undefined
    const MAX_PAGES = 50

    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await fetchPage(authToken, ct0, cursor)
      const { tweets, nextCursor } = parsePage(data)

      // On the first page, verify the API response structure hasn't changed
      if (page === 0 && tweets.length === 0 && !nextCursor) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hasTimeline = (data as any)?.data?.bookmark_timeline_v2?.timeline
        if (!hasTimeline) {
          throw new Error('Twitter API response format has changed. The sync feature may need updating.')
        }
      }

      const result = await importTweets(tweets)
      imported += result.imported
      skipped += result.skipped

      if (!nextCursor || tweets.length === 0) break
      cursor = nextCursor

      if (page === MAX_PAGES - 1) {
        console.warn(`[x-sync] Hit max page limit (${MAX_PAGES}), stopping pagination`)
      }
    }

    // Only update last sync timestamp if we actually fetched tweets
    if (imported > 0 || skipped > 0) {
      const now = new Date().toISOString()
      await prisma.setting.upsert({
        where: { key: 'x_last_sync' },
        update: { value: now },
        create: { key: 'x_last_sync', value: now },
      })
    }

    return { imported, skipped }
  } finally {
    syncing = false
  }
}

// ── Internal HTTP helper ─────────────────────────────────────────────────────

async function internalFetch(path: string, options?: RequestInit) {
  const baseUrl = process.env.SIFTLY_INTERNAL_BASE_URL?.trim() || `http://127.0.0.1:${process.env.PORT || 3000}`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options?.headers as Record<string, string>) || {}),
  }

  // Add Basic Auth if middleware is configured
  const username = process.env.SIFTLY_USERNAME?.trim()
  const password = process.env.SIFTLY_PASSWORD?.trim()
  if (username && password) {
    headers['Authorization'] = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  }

  return fetch(`${baseUrl.replace(/\/$/, '')}${path}`, { ...options, headers })
}

// ── Sync via OAuth (uses existing API endpoint) ──────────────────────────────

async function syncOAuthBookmarks(): Promise<{ imported: number; skipped: number } | null> {
  const [accessToken, userId] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'x_oauth_access_token' } }),
    prisma.setting.findUnique({ where: { key: 'x_oauth_user_id' } }),
  ])

  if (!accessToken?.value || !userId?.value) return null

  const res = await internalFetch('/api/import/x-oauth/fetch', {
    method: 'POST',
    body: JSON.stringify({}),
  })

  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'OAuth fetch failed')

  if (data.rateLimited) {
    console.warn(`[x-sync] OAuth sync rate limited (${data.rateLimitReason}), imported ${data.imported ?? 0} so far`)
    return { imported: data.imported ?? 0, skipped: data.skipped ?? 0 }
  }

  return { imported: data.imported ?? 0, skipped: data.skipped ?? 0 }
}

// ── Trigger categorization for new bookmarks ─────────────────────────────────

async function triggerCategorization(): Promise<void> {
  // Only run if there are uncategorized bookmarks
  const uncategorized = await prisma.bookmark.count({ where: { enrichedAt: null } })
  if (uncategorized === 0) {
    console.log('[x-sync] No uncategorized bookmarks, skipping pipeline')
    return
  }

  console.log(`[x-sync] Triggering categorization for ${uncategorized} uncategorized bookmarks`)
  const res = await internalFetch('/api/categorize', {
    method: 'POST',
    body: JSON.stringify({}),
  })

  if (!res.ok) {
    const data = await res.json()
    // 409 = already running, that's fine
    if (res.status !== 409) {
      console.error('[x-sync] Failed to trigger categorization:', data.error)
    }
  } else {
    console.log('[x-sync] Categorization pipeline started')
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────────

type SyncInterval = '1h' | '4h' | '8h' | '24h' | 'daily'

const INTERVAL_MS: Partial<Record<SyncInterval, number>> = {
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null
let cronTask: ScheduledTask | null = null
let syncing = false

export async function startScheduler() {
  stopScheduler()

  const intervalSetting = await prisma.setting.findUnique({ where: { key: 'x_sync_interval' } })
  if (!intervalSetting?.value || intervalSetting.value === 'off') return

  const interval = intervalSetting.value as SyncInterval

  if (interval === 'daily') {
    // Cron: every day at 00:00
    cronTask = cronSchedule('0 0 * * *', () => void runScheduledSync())
    console.log('[x-sync] Daily scheduler started: runs at 00:00')
    return
  }

  const ms = INTERVAL_MS[interval]
  if (!ms) {
    console.warn(`[x-sync] Invalid sync interval "${intervalSetting.value}", not starting scheduler`)
    return
  }

  schedulerTimer = setInterval(() => void runScheduledSync(), ms)
  console.log(`[x-sync] Scheduler started: every ${interval}`)
}

export function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
    console.log('[x-sync] Interval scheduler stopped')
  }
  if (cronTask) {
    cronTask.stop()
    cronTask = null
    console.log('[x-sync] Daily cron scheduler stopped')
  }
}

async function runScheduledSync() {
  if (syncing) return
  syncing = true

  try {
    console.log(`[x-sync] Running scheduled sync at ${new Date().toISOString()}`)

    let result: { imported: number; skipped: number } | null = null

    // Try OAuth first (official API, preferred)
    try {
      result = await syncOAuthBookmarks()
      if (result) {
        console.log(`[x-sync] OAuth sync: ${result.imported} imported, ${result.skipped} skipped`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('[x-sync] OAuth sync failed, trying headless:', msg)
    }

    // Fall back to headless sync (auth_token + ct0)
    if (!result) {
      const [authSetting, ct0Setting] = await Promise.all([
        prisma.setting.findUnique({ where: { key: 'x_auth_token' } }),
        prisma.setting.findUnique({ where: { key: 'x_ct0' } }),
      ])

      if (!authSetting?.value || !ct0Setting?.value) {
        console.log('[x-sync] Skipping scheduled sync: no credentials available (neither OAuth nor headless)')
        return
      }

      // syncBookmarks sets syncing=true internally, but we've already set it
      syncing = false
      result = await syncBookmarks(authSetting.value, ct0Setting.value)
      console.log(`[x-sync] Headless sync: ${result.imported} imported, ${result.skipped} skipped`)
    }

    // Auto-categorize if new bookmarks were imported
    if (result.imported > 0) {
      console.log(`[x-sync] ${result.imported} new bookmarks — triggering categorization`)
      await triggerCategorization()
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[x-sync] Scheduled sync failed:', message)
    if (message.includes('401') || message.includes('403')) {
      console.error('[x-sync] Auth error detected, stopping scheduler')
      stopScheduler()
    }
  } finally {
    syncing = false
  }
}

export function isSchedulerRunning() {
  return schedulerTimer !== null || cronTask !== null
}

export function isSyncing() {
  return syncing
}

export function getSchedulerType(): 'cron' | 'interval' | null {
  if (cronTask) return 'cron'
  if (schedulerTimer) return 'interval'
  return null
}
