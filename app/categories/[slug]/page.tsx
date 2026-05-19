'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Download, ArrowLeft, Loader2 } from 'lucide-react'
import BookmarkCard from '@/components/bookmark-card'
import { hasMorePagedItems, mergePagedItemsById } from '@/lib/paged-items'
import type { BookmarkWithMedia, Category } from '@/lib/types'

const PAGE_SIZE = 24

interface EngagementBandSummary {
  slug: string
  label: string
  count: number
}

interface EngagementSubcategoryGroup {
  metric: 'likes' | 'views'
  label: string
  missingCount: number
  bands: EngagementBandSummary[]
}

interface CategoryPageData {
  category: Category
  bookmarks: BookmarkWithMedia[]
  total: number
  subcategories: EngagementSubcategoryGroup[]
}

function SubcategoryFilterGroup({
  title,
  bands,
  activeValue,
  onChange,
  missingCount,
  tone,
}: {
  title: string
  bands: EngagementBandSummary[]
  activeValue: string
  onChange: (value: string) => void
  missingCount: number
  tone: 'views' | 'likes'
}) {
  const activeClasses = tone === 'views'
    ? 'border-sky-500/40 bg-sky-500/12 text-sky-200'
    : 'border-rose-500/40 bg-rose-500/12 text-rose-200'

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-sm font-semibold text-zinc-100">{title}</p>
        {missingCount > 0 && (
          <span className="text-xs text-zinc-500">
            {missingCount.toLocaleString()} without data
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => onChange('')}
          className={`px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
            activeValue
              ? 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
              : activeClasses
          }`}
        >
          All
        </button>

        {bands.map((band) => {
          const isActive = activeValue === band.slug
          return (
            <button
              key={band.slug}
              onClick={() => onChange(isActive ? '' : band.slug)}
              className={`px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
                isActive
                  ? activeClasses
                  : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
              }`}
            >
              {band.label} · {band.count.toLocaleString()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default function CategoryPage() {
  const { slug } = useParams<{ slug: string }>()
  const { push } = useRouter()
  const [data, setData] = useState<CategoryPageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState('')
  const [likesBand, setLikesBand] = useState('')
  const [viewsBand, setViewsBand] = useState('')
  const bookmarksRef = useRef<BookmarkWithMedia[]>([])
  const loadSequenceRef = useRef(0)
  const loadingMoreRef = useRef(false)
  const pageRef = useRef(1)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  const fetchData = useCallback(async (p: number, mode: 'replace' | 'append' = 'replace') => {
    if (mode === 'append' && loadingMoreRef.current) return

    const sequence = ++loadSequenceRef.current
    if (mode === 'replace') {
      setLoading(true)
      setLoadingMore(false)
      loadingMoreRef.current = false
      setError('')
    } else {
      loadingMoreRef.current = true
      setLoadingMore(true)
    }

    try {
      const bookmarkParams = new URLSearchParams({
        category: slug,
        page: String(p),
        limit: String(PAGE_SIZE),
      })

      if (likesBand) bookmarkParams.set('likesBand', likesBand)
      if (viewsBand) bookmarkParams.set('viewsBand', viewsBand)

      const [catRes, bookmarksRes] = await Promise.all([
        mode === 'replace' ? fetch(`/api/categories/${slug}`) : Promise.resolve(null),
        fetch(`/api/bookmarks?${bookmarkParams.toString()}`),
      ])

      if (catRes && !catRes.ok) {
        push('/categories')
        return
      }

      if (!bookmarksRes.ok) throw new Error('Failed to fetch bookmarks')

      const catData = catRes ? await catRes.json() : null
      const bmData = await bookmarksRes.json()
      if (sequence !== loadSequenceRef.current) return

      const incomingBookmarks = bmData.bookmarks ?? []
      const total = bmData.total ?? 0
      const nextBookmarks = mode === 'append'
        ? mergePagedItemsById(bookmarksRef.current, incomingBookmarks)
        : incomingBookmarks

      bookmarksRef.current = nextBookmarks
      pageRef.current = p
      setHasMore(hasMorePagedItems(nextBookmarks.length, total))

      setData((prev) => {
        const category = catData?.category ?? prev?.category
        if (!category) return prev

        return {
          category,
          subcategories: catData?.subcategories ?? prev?.subcategories ?? [],
          bookmarks: nextBookmarks,
          total,
        }
      })
    } catch (err) {
      console.error(err)
      if (sequence === loadSequenceRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load bookmarks')
      }
    } finally {
      if (sequence === loadSequenceRef.current) {
        if (mode === 'replace') setLoading(false)
        else setLoadingMore(false)
      }
      if (mode === 'append') loadingMoreRef.current = false
    }
  }, [slug, push, likesBand, viewsBand])

  useEffect(() => {
    bookmarksRef.current = []
    pageRef.current = 1
    setHasMore(false)
    setData((prev) => prev ? { ...prev, bookmarks: [], total: 0 } : prev)
    void fetchData(1, 'replace')
  }, [fetchData])

  useEffect(() => {
    if (!hasMore || loading || loadingMore) return
    const node = sentinelRef.current
    if (!node) return

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void fetchData(pageRef.current + 1, 'append')
      }
    }, { rootMargin: '600px 0px' })

    observer.observe(node)
    return () => observer.disconnect()
  }, [fetchData, hasMore, loading, loadingMore])

  function handleExport() {
    window.location.href = `/api/export?type=zip&category=${slug}`
  }

  if (loading && !data) {
    return (
      <div className="p-8 max-w-7xl mx-auto">
        <div className="h-8 w-48 bg-zinc-800 rounded animate-pulse mb-4" />
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-xl h-48 animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  const category = data?.category
  const bookmarks = data?.bookmarks ?? []
  const total = data?.total ?? 0
  const subcategories = data?.subcategories ?? []
  const hasEngagementFilters = !!(likesBand || viewsBand)
  const viewsGroup = subcategories.find((group) => group.metric === 'views')
  const likesGroup = subcategories.find((group) => group.metric === 'likes')

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <button
        onClick={() => push('/categories')}
        className="flex items-center gap-2 text-sm text-zinc-500 hover:text-zinc-300 transition-colors mb-6"
      >
        <ArrowLeft size={14} />
        All Categories
      </button>

      {category && (
        <div className="flex items-start justify-between gap-4 mb-8">
          <div className="flex items-center gap-3">
            <div
              className="size-4 rounded-full shrink-0"
              style={{ backgroundColor: category.color }}
            />
            <div>
              <h1 className="text-2xl font-semibold text-zinc-100">{category.name}</h1>
              {category.description && (
                <p className="text-zinc-400 text-sm mt-0.5">{category.description}</p>
              )}
              <p className="text-zinc-500 text-sm mt-1">
                {total.toLocaleString()} bookmark{total !== 1 ? 's' : ''}
                {hasEngagementFilters ? ' in current subcategory' : ''}
              </p>
            </div>
          </div>
          <button
            onClick={handleExport}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors shrink-0"
          >
            <Download size={15} />
            Export ZIP
          </button>
        </div>
      )}

      {category && (viewsGroup?.bands.length || likesGroup?.bands.length) && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-8">
          {viewsGroup && viewsGroup.bands.length > 0 && (
            <SubcategoryFilterGroup
              title={viewsGroup.label}
              bands={viewsGroup.bands}
              activeValue={viewsBand}
              onChange={(value) => {
                setViewsBand(value)
              }}
              missingCount={viewsGroup.missingCount}
              tone="views"
            />
          )}
          {likesGroup && likesGroup.bands.length > 0 && (
            <SubcategoryFilterGroup
              title={likesGroup.label}
              bands={likesGroup.bands}
              activeValue={likesBand}
              onChange={(value) => {
                setLikesBand(value)
              }}
              missingCount={likesGroup.missingCount}
              tone="likes"
            />
          )}
        </div>
      )}

      {loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-xl h-48 animate-pulse" />
          ))}
        </div>
      )}

      {!loading && bookmarks.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <p className="text-xl font-semibold text-zinc-400">No bookmarks in this category</p>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {!loading && bookmarks.length > 0 && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {bookmarks.map((bookmark) => (
              <BookmarkCard key={bookmark.id} bookmark={bookmark} />
            ))}
          </div>

          <div ref={sentinelRef} className="mt-8 flex min-h-12 items-center justify-center">
            {loadingMore ? (
              <div className="flex items-center gap-2 text-sm text-zinc-500">
                <Loader2 size={16} className="animate-spin" />
                Loading more
              </div>
            ) : hasMore ? (
              <div className="size-8" aria-hidden="true" />
            ) : (
              <p className="text-sm text-zinc-600">
                {bookmarks.length.toLocaleString()} of {total.toLocaleString()} bookmarks loaded
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
