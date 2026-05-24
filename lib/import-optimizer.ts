import type { ParsedBookmark } from '@/lib/parser'

export interface ImportBookmarkPlan {
  bookmarks: ParsedBookmark[]
  skippedCount: number
}

export function planImportBookmarks(
  bookmarks: ParsedBookmark[],
  existingTweetIds: Set<string>,
): ImportBookmarkPlan {
  const seenTweetIds = new Set<string>()
  const planned: ParsedBookmark[] = []
  let skippedCount = 0

  for (const bookmark of bookmarks) {
    if (existingTweetIds.has(bookmark.tweetId) || seenTweetIds.has(bookmark.tweetId)) {
      skippedCount++
      continue
    }

    seenTweetIds.add(bookmark.tweetId)
    planned.push(bookmark)
  }

  return { bookmarks: planned, skippedCount }
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []

  const results: R[] = []
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(limit, items.length))

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await mapper(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}
