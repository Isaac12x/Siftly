export interface BookmarkEngagement {
  likes: number | null
  views: number | null
}

export type EngagementMetric = 'likes' | 'views'

export interface EngagementBand {
  slug: string
  label: string
  min: number
  max: number | null
}

export interface EngagementBandSummary extends EngagementBand {
  count: number
}

export interface EngagementSubcategoryGroup {
  metric: EngagementMetric
  label: string
  missingCount: number
  bands: EngagementBandSummary[]
}

const LIKE_BANDS: EngagementBand[] = [
  { slug: 'under-500', label: 'Under 500', min: 0, max: 500 },
  { slug: '500-to-2k', label: '500-2K', min: 500, max: 2_000 },
  { slug: '2k-to-10k', label: '2K-10K', min: 2_000, max: 10_000 },
  { slug: '10k-plus', label: '10K+', min: 10_000, max: null },
]

const VIEW_BANDS: EngagementBand[] = [
  { slug: 'under-50k', label: 'Under 50K', min: 0, max: 50_000 },
  { slug: '50k-to-250k', label: '50K-250K', min: 50_000, max: 250_000 },
  { slug: '250k-to-1m', label: '250K-1M', min: 250_000, max: 1_000_000 },
  { slug: '1m-plus', label: '1M+', min: 1_000_000, max: null },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getNested(value: unknown, ...keys: string[]): unknown {
  let current = value
  for (const key of keys) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

function parseNumberish(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const normalized = value.trim().replace(/,/g, '')
    if (!normalized) return null
    const parsed = Number(normalized)
    return Number.isFinite(parsed) ? parsed : null
  }

  if (isRecord(value) && 'count' in value) {
    return parseNumberish(value.count)
  }

  return null
}

function resolveLikes(tweet: unknown): number | null {
  return parseNumberish(
    getNested(tweet, 'favorite_count') ??
    getNested(tweet, 'legacy', 'favorite_count') ??
    getNested(tweet, 'public_metrics', 'like_count') ??
    getNested(tweet, 'like_count'),
  )
}

function resolveViews(tweet: unknown): number | null {
  return parseNumberish(
    getNested(tweet, 'views_count') ??
    getNested(tweet, 'view_count') ??
    getNested(tweet, 'legacy', 'views_count') ??
    getNested(tweet, 'legacy', 'view_count') ??
    getNested(tweet, 'views', 'count') ??
    getNested(tweet, 'public_metrics', 'impression_count'),
  )
}

export function extractBookmarkEngagementFromTweet(tweet: unknown): BookmarkEngagement {
  return {
    likes: resolveLikes(tweet),
    views: resolveViews(tweet),
  }
}

export function extractBookmarkEngagement(rawJson: string): BookmarkEngagement {
  if (!rawJson) {
    return { likes: null, views: null }
  }

  try {
    return extractBookmarkEngagementFromTweet(JSON.parse(rawJson) as unknown)
  } catch {
    return { likes: null, views: null }
  }
}

export function getEngagementBands(metric: EngagementMetric): EngagementBand[] {
  return metric === 'likes' ? LIKE_BANDS : VIEW_BANDS
}

export function getEngagementBand(
  metric: EngagementMetric,
  value: number | null | undefined,
): EngagementBand | null {
  if (value == null) return null

  return (
    getEngagementBands(metric).find(
      (band) => value >= band.min && (band.max == null || value < band.max),
    ) ?? null
  )
}

export function matchesEngagementBand(
  metric: EngagementMetric,
  value: number | null | undefined,
  bandSlug: string,
): boolean {
  if (!bandSlug) return true

  const band = getEngagementBands(metric).find((item) => item.slug === bandSlug)
  if (!band) return true
  if (value == null) return false

  return value >= band.min && (band.max == null || value < band.max)
}

export function summarizeEngagementSubcategories(
  engagements: BookmarkEngagement[],
): EngagementSubcategoryGroup[] {
  return (['views', 'likes'] as const).map((metric) => {
    const bands = getEngagementBands(metric)
      .map((band) => ({
        ...band,
        count: engagements.filter((engagement) =>
          matchesEngagementBand(metric, engagement[metric], band.slug),
        ).length,
      }))
      .filter((band) => band.count > 0)

    return {
      metric,
      label: metric === 'views' ? 'By views' : 'By likes',
      missingCount: engagements.filter((engagement) => engagement[metric] == null).length,
      bands,
    }
  })
}
