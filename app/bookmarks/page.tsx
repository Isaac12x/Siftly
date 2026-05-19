'use client'

import { useState, useEffect, useRef, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  Search,
  BookmarkX,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  List,
  X,
  ChevronDown,
  ArrowUpDown,
} from 'lucide-react'
import * as Select from '@radix-ui/react-select'
import BookmarkCard from '@/components/bookmark-card'
import type { BookmarkWithMedia, BookmarksResponse, Category } from '@/lib/types'

const PAGE_SIZE = 24

interface Filters {
  q: string
  category: string
  mediaType: string
  source: string
  sort: string
  page: number
  uncategorized: boolean
}

const DEFAULT_FILTERS: Filters = {
  q: '',
  category: '',
  mediaType: '',
  source: '',
  sort: 'newest',
  page: 1,
  uncategorized: false,
}

function parsePage(value: string | null): number {
  if (!value) return DEFAULT_FILTERS.page
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) || parsed < 1 ? DEFAULT_FILTERS.page : parsed
}

function getFiltersFromParams(params: URLSearchParams): Filters {
  const sort = params.get('sort') === 'oldest' ? 'oldest' : 'newest'

  return {
    q: params.get('q') ?? '',
    category: params.get('category') ?? '',
    mediaType: params.get('mediaType') ?? '',
    source: params.get('source') ?? '',
    sort,
    page: parsePage(params.get('page')),
    uncategorized: params.get('uncategorized') === 'true',
  }
}

function areFiltersEqual(left: Filters, right: Filters): boolean {
  return (
    left.q === right.q &&
    left.category === right.category &&
    left.mediaType === right.mediaType &&
    left.source === right.source &&
    left.sort === right.sort &&
    left.page === right.page &&
    left.uncategorized === right.uncategorized
  )
}

function buildApiUrl(filters: Filters): string {
  const params = new URLSearchParams()
  if (filters.q) params.set('q', filters.q)
  if (filters.uncategorized) {
    params.set('uncategorized', 'true')
  } else if (filters.category) {
    params.set('category', filters.category)
  }
  if (filters.mediaType) params.set('mediaType', filters.mediaType)
  if (filters.source) params.set('source', filters.source)
  params.set('sort', filters.sort)
  params.set('page', String(filters.page))
  params.set('limit', String(PAGE_SIZE))
  return `/api/bookmarks?${params.toString()}`
}

function buildPageUrl(filters: Filters): string {
  const params = new URLSearchParams()
  if (filters.q) params.set('q', filters.q)
  if (filters.uncategorized) {
    params.set('uncategorized', 'true')
  } else if (filters.category) {
    params.set('category', filters.category)
  }
  if (filters.mediaType) params.set('mediaType', filters.mediaType)
  if (filters.source) params.set('source', filters.source)
  if (filters.sort !== DEFAULT_FILTERS.sort) params.set('sort', filters.sort)
  if (filters.page > 1) params.set('page', String(filters.page))

  const query = params.toString()
  return query ? `/bookmarks?${query}` : '/bookmarks'
}

function formatCategoryLabel(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function SelectMenu({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  options: { label: string; value: string }[]
  placeholder: string
}) {
  return (
    <Select.Root value={value || '_all'} onValueChange={(v) => onChange(v === '_all' ? '' : v)}>
      <Select.Trigger className="flex min-w-[132px] shrink-0 items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2.5 text-sm text-zinc-300 transition-all hover:border-zinc-700 hover:text-zinc-100 focus:outline-none focus:border-sky-500/60">
        <Select.Value placeholder={placeholder} />
        <Select.Icon className="ml-auto">
          <ChevronDown size={13} className="text-zinc-600" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="z-50 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/60">
          <Select.Viewport className="p-1.5">
            <Select.Item
              value="_all"
              className="cursor-pointer rounded-xl px-3 py-2 text-sm text-zinc-500 outline-none transition-colors hover:bg-zinc-900 hover:text-zinc-100 data-[highlighted]:bg-zinc-900 data-[highlighted]:text-zinc-100"
            >
              <Select.ItemText>{placeholder}</Select.ItemText>
            </Select.Item>
            {options.map((opt) => (
              <Select.Item
                key={opt.value}
                value={opt.value}
                className="cursor-pointer rounded-xl px-3 py-2 text-sm text-zinc-300 outline-none transition-colors hover:bg-zinc-900 hover:text-zinc-100 data-[highlighted]:bg-zinc-900 data-[highlighted]:text-zinc-100"
              >
                <Select.ItemText>{opt.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}

function SkeletonCard() {
  return (
    <div className="masonry-item">
      <div className="overflow-hidden rounded-[24px] border border-zinc-800 bg-zinc-900/70 animate-pulse">
        <div className="aspect-[16/10] bg-zinc-800/90" />
        <div className="space-y-3 p-4">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-full bg-zinc-800" />
            <div className="space-y-1.5">
              <div className="h-3 w-24 rounded-full bg-zinc-800" />
              <div className="h-2.5 w-20 rounded-full bg-zinc-800" />
            </div>
          </div>
          <div className="space-y-2">
            <div className="h-3 w-full rounded-full bg-zinc-800" />
            <div className="h-3 w-5/6 rounded-full bg-zinc-800" />
            <div className="h-3 w-3/4 rounded-full bg-zinc-800" />
          </div>
          <div className="flex gap-2 pt-3">
            <div className="h-5 w-16 rounded-full bg-zinc-800" />
            <div className="h-5 w-20 rounded-full bg-zinc-800" />
          </div>
        </div>
      </div>
    </div>
  )
}

function Pagination({
  page,
  total,
  limit,
  onChange,
}: {
  page: number
  total: number
  limit: number
  onChange: (p: number) => void
}) {
  const totalPages = Math.ceil(total / limit)
  if (totalPages <= 1) return null

  const getPageNumbers = (): (number | 'ellipsis')[] => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1)
    const pages: (number | 'ellipsis')[] = [1]
    if (page > 3) pages.push('ellipsis')
    const start = Math.max(2, page - 1)
    const end = Math.min(totalPages - 1, page + 1)
    for (let i = start; i <= end; i++) pages.push(i)
    if (page < totalPages - 2) pages.push('ellipsis')
    pages.push(totalPages)
    return pages
  }

  return (
    <div className="mt-12 flex items-center justify-center gap-1.5">
      <button
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        className="flex items-center gap-1.5 rounded-2xl border border-zinc-800 bg-zinc-900 px-3.5 py-2 text-sm font-medium text-zinc-400 transition-all hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-25"
      >
        <ChevronLeft size={14} />
        Prev
      </button>

      <div className="flex items-center gap-1">
        {getPageNumbers().map((item, index) =>
          item === 'ellipsis' ? (
            <span key={`ellipsis-${index}`} className="px-2 text-sm text-zinc-700 select-none">&hellip;</span>
          ) : (
            <button
              key={item}
              onClick={() => onChange(item)}
              className={`h-9 w-9 rounded-2xl text-sm font-medium transition-all ${
                item === page
                  ? 'border border-sky-400/50 bg-sky-500/20 text-white shadow-lg shadow-sky-500/10'
                  : 'border border-zinc-800 bg-zinc-900 text-zinc-500 hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-100'
              }`}
            >
              {item}
            </button>
          ),
        )}
      </div>

      <button
        onClick={() => onChange(page + 1)}
        disabled={page >= totalPages}
        className="flex items-center gap-1.5 rounded-2xl border border-zinc-800 bg-zinc-900 px-3.5 py-2 text-sm font-medium text-zinc-400 transition-all hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-25"
      >
        Next
        <ChevronRight size={14} />
      </button>
    </div>
  )
}

function BookmarksPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialFilters = getFiltersFromParams(new URLSearchParams(searchParams.toString()))

  const [filters, setFilters] = useState<Filters>(initialFilters)
  const [searchInput, setSearchInput] = useState(initialFilters.q)
  const [bookmarks, setBookmarks] = useState<BookmarkWithMedia[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchBookmarks = useCallback(async (nextFilters: Filters) => {
    setLoading(true)
    try {
      const res = await fetch(buildApiUrl(nextFilters))
      if (!res.ok) throw new Error('Failed to fetch bookmarks')
      const data: BookmarksResponse = await res.json()
      setBookmarks(data.bookmarks)
      setTotal(data.total)
    } catch (err) {
      console.error(err)
      setBookmarks([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchBookmarks(filters)
  }, [fetchBookmarks, filters])

  useEffect(() => {
    fetch('/api/categories')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch categories')
        return res.json()
      })
      .then((data: { categories?: Category[] }) => {
        const nextCategories = [...(data.categories ?? [])]
          .sort((left, right) => right.bookmarkCount - left.bookmarkCount)
        setCategories(nextCategories)
      })
      .catch((err) => {
        console.error(err)
        setCategories([])
      })
  }, [])

  useEffect(() => {
    const nextFilters = getFiltersFromParams(new URLSearchParams(searchParams.toString()))
    if (!areFiltersEqual(filters, nextFilters)) {
      setFilters(nextFilters)
    }
    setSearchInput(nextFilters.q)
  }, [filters, searchParams])

  useEffect(() => {
    const nextUrl = buildPageUrl(filters)
    const currentUrl = buildPageUrl(getFiltersFromParams(new URLSearchParams(searchParams.toString())))

    if (nextUrl !== currentUrl) {
      router.replace(nextUrl, { scroll: false })
    }
  }, [filters, router, searchParams])

  useEffect(() => {
    return () => {
      if (searchRef.current) clearTimeout(searchRef.current)
    }
  }, [])

  function updateSearch(value: string) {
    setSearchInput(value)
    if (searchRef.current) clearTimeout(searchRef.current)
    searchRef.current = setTimeout(() => {
      setFilters((prev) => ({ ...prev, q: value.trim(), page: 1 }))
    }, 250)
  }

  function updateFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((prev) => {
      const next = { ...prev, [key]: value, page: 1 }

      if (key === 'category' && typeof value === 'string' && value) {
        next.uncategorized = false
      }

      if (key === 'uncategorized' && value === true) {
        next.category = ''
      }

      return next
    })
  }

  function clearAllFilters() {
    setSearchInput('')
    setFilters(DEFAULT_FILTERS)
  }

  const mediaOptions = [
    { label: 'Photos', value: 'photo' },
    { label: 'Videos', value: 'video' },
  ]

  const sourceOptions = [
    { label: 'Bookmarks', value: 'bookmark' },
    { label: 'Likes', value: 'like' },
  ]

  const sortOptions = [
    { label: 'Newest first', value: 'newest' },
    { label: 'Oldest first', value: 'oldest' },
  ]

  const categoryOptions = categories
    .filter((category) => category.bookmarkCount > 0)
    .map((category) => ({
      label: `${category.name} · ${category.bookmarkCount.toLocaleString()}`,
      value: category.slug,
    }))

  const quickCategories = categories.filter((category) => category.bookmarkCount > 0).slice(0, 6)
  const hasActiveFilters = !!(
    filters.q ||
    filters.category ||
    filters.mediaType ||
    filters.source ||
    filters.sort !== DEFAULT_FILTERS.sort ||
    filters.uncategorized
  )
  const sortLabel = sortOptions.find((option) => option.value === filters.sort)?.label ?? 'Newest first'
  const selectedCategoryName = categories.find((category) => category.slug === filters.category)?.name
    ?? (filters.category ? formatCategoryLabel(filters.category) : '')

  return (
    <div className="min-h-full bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.08),transparent_32%),radial-gradient(circle_at_top_right,rgba(251,191,36,0.06),transparent_28%),linear-gradient(180deg,#09090b_0%,#09090b_40%,#0b0b0e_100%)]">
      <div className="sticky top-0 z-20 border-b border-zinc-800/70 bg-zinc-950/88 backdrop-blur-xl">
        <div className="px-5 py-5 md:px-8">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.26em] text-sky-300/70">Library</p>
                <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl">
                  Browse bookmarks
                </h1>
                <p className="mt-1 max-w-2xl text-sm text-zinc-400">
                  Search across text, authors, categories, AI tags, and image descriptions without leaving your archive.
                </p>
              </div>

              {!loading && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-zinc-800 bg-zinc-900/80 px-3 py-1.5 text-xs font-medium text-zinc-300">
                    {total.toLocaleString()} results
                  </span>
                  <span className="rounded-full border border-zinc-800 bg-zinc-900/80 px-3 py-1.5 text-xs font-medium text-zinc-500">
                    {filters.q ? 'Ranked by match + recency' : sortLabel}
                  </span>
                </div>
              )}
            </div>

            <div className="rounded-[28px] border border-zinc-800/80 bg-zinc-900/70 p-3 shadow-[0_20px_50px_rgba(0,0,0,0.18)] md:p-4">
              <div className="flex flex-col gap-3 xl:flex-row">
                <div className="relative xl:min-w-0 xl:flex-[1.7]">
                  <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-zinc-600" />
                  <input
                    type="text"
                    placeholder="Search bookmarks, people, tags, or what’s inside images…"
                    value={searchInput}
                    onChange={(e) => updateSearch(e.target.value)}
                    className="w-full rounded-[22px] border border-zinc-800 bg-zinc-950/85 py-3 pl-11 pr-10 text-sm text-zinc-100 placeholder:text-zinc-600 transition-all focus:outline-none focus:border-sky-500/60 focus:ring-1 focus:ring-sky-500/20"
                  />
                  {searchInput && (
                    <button
                      onClick={() => updateSearch('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-zinc-600 transition-colors hover:text-zinc-300"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 xl:flex-1">
                  <SelectMenu
                    value={filters.category}
                    onChange={(value) => updateFilter('category', value)}
                    options={categoryOptions}
                    placeholder="All collections"
                  />
                  <SelectMenu
                    value={filters.mediaType}
                    onChange={(value) => updateFilter('mediaType', value)}
                    options={mediaOptions}
                    placeholder="All media"
                  />
                  <SelectMenu
                    value={filters.source}
                    onChange={(value) => updateFilter('source', value)}
                    options={sourceOptions}
                    placeholder="All sources"
                  />

                  <button
                    onClick={() => updateFilter('sort', filters.sort === 'newest' ? 'oldest' : 'newest')}
                    className="flex shrink-0 items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2.5 text-sm text-zinc-300 transition-all hover:border-zinc-700 hover:text-zinc-100"
                    title={`Sort: ${sortLabel}`}
                  >
                    <ArrowUpDown size={13} />
                    <span className="hidden sm:inline">{sortLabel}</span>
                  </button>

                  <div className="flex items-center gap-1 rounded-2xl border border-zinc-800 bg-zinc-950/70 p-1">
                    <button
                      onClick={() => setViewMode('grid')}
                      className={`rounded-xl p-2 transition-all ${
                        viewMode === 'grid'
                          ? 'bg-sky-500/20 text-zinc-100'
                          : 'text-zinc-600 hover:text-zinc-300'
                      }`}
                      aria-label="Grid view"
                    >
                      <LayoutGrid size={14} />
                    </button>
                    <button
                      onClick={() => setViewMode('list')}
                      className={`rounded-xl p-2 transition-all ${
                        viewMode === 'list'
                          ? 'bg-sky-500/20 text-zinc-100'
                          : 'text-zinc-600 hover:text-zinc-300'
                      }`}
                      aria-label="List view"
                    >
                      <List size={14} />
                    </button>
                  </div>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => setFilters((prev) => ({ ...DEFAULT_FILTERS, q: prev.q }))}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${
                    !filters.category && !filters.uncategorized
                      ? 'border-sky-400/40 bg-sky-500/15 text-sky-200'
                      : 'border-zinc-800 bg-zinc-950/60 text-zinc-500 hover:border-zinc-700 hover:text-zinc-200'
                  }`}
                >
                  All items
                </button>
                <button
                  onClick={() => updateFilter('uncategorized', !filters.uncategorized)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${
                    filters.uncategorized
                      ? 'border-amber-400/40 bg-amber-500/10 text-amber-200'
                      : 'border-zinc-800 bg-zinc-950/60 text-zinc-500 hover:border-zinc-700 hover:text-zinc-200'
                  }`}
                >
                  Uncategorized
                </button>
                {quickCategories.map((category) => (
                  <button
                    key={category.id}
                    onClick={() => updateFilter('category', category.slug)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${
                      filters.category === category.slug
                        ? 'text-white'
                        : 'border-zinc-800 bg-zinc-950/60 text-zinc-500 hover:border-zinc-700 hover:text-zinc-200'
                    }`}
                    style={filters.category === category.slug
                      ? {
                          backgroundColor: `${category.color}24`,
                          borderColor: `${category.color}55`,
                          color: '#ffffff',
                        }
                      : undefined}
                  >
                    {category.name}
                  </button>
                ))}
                {hasActiveFilters && (
                  <button
                    onClick={clearAllFilters}
                    className="ml-auto rounded-full border border-zinc-800 bg-zinc-950/60 px-3 py-1.5 text-xs font-medium text-zinc-500 transition-colors hover:border-zinc-700 hover:text-zinc-200"
                  >
                    Clear all
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 px-5 py-6 md:px-8">
        <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-zinc-600">Results</p>
            <h2 className="mt-1 text-lg font-semibold text-zinc-100">
              {loading ? 'Searching your archive…' : `${total.toLocaleString()} bookmark${total === 1 ? '' : 's'}`}
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
              {filters.q
                ? <>Matching <span className="text-zinc-300">&ldquo;{filters.q}&rdquo;</span>{selectedCategoryName ? ` in ${selectedCategoryName}` : ''}.</>
                : 'Browse your archive by source, collection, and media type.'}
            </p>
          </div>

          {hasActiveFilters && (
            <div className="flex flex-wrap items-center gap-2">
              {filters.q && (
                <span className="rounded-full border border-sky-500/20 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-200">
                  Query: {filters.q}
                </span>
              )}
              {filters.category && (
                <span className="rounded-full border border-indigo-500/20 bg-indigo-500/10 px-3 py-1.5 text-xs font-medium text-indigo-200">
                  {selectedCategoryName}
                </span>
              )}
              {filters.uncategorized && (
                <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-200">
                  Uncategorized
                </span>
              )}
              {filters.mediaType && (
                <span className="rounded-full border border-zinc-800 bg-zinc-900/80 px-3 py-1.5 text-xs font-medium text-zinc-300">
                  {mediaOptions.find((option) => option.value === filters.mediaType)?.label}
                </span>
              )}
              {filters.source && (
                <span className="rounded-full border border-zinc-800 bg-zinc-900/80 px-3 py-1.5 text-xs font-medium text-zinc-300">
                  {sourceOptions.find((option) => option.value === filters.source)?.label}
                </span>
              )}
              {filters.sort !== DEFAULT_FILTERS.sort && (
                <span className="rounded-full border border-zinc-800 bg-zinc-900/80 px-3 py-1.5 text-xs font-medium text-zinc-300">
                  {sortLabel}
                </span>
              )}
            </div>
          )}
        </div>

        {loading && (
          <div className="masonry-grid">
            {Array.from({ length: 9 }).map((_, index) => <SkeletonCard key={index} />)}
          </div>
        )}

        {!loading && bookmarks.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-[28px] border border-zinc-800/80 bg-zinc-900/60 py-24 text-center">
            <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-3xl border border-zinc-800 bg-zinc-950">
              <BookmarkX size={26} className="text-zinc-700" />
            </div>
            <h3 className="text-base font-semibold text-zinc-300">No bookmarks match this view</h3>
            <p className="mt-2 max-w-sm text-sm text-zinc-500">
              Try a broader query, switch collections, or clear the current filters.
            </p>
            {hasActiveFilters && (
              <button
                onClick={clearAllFilters}
                className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100"
              >
                Clear filters
              </button>
            )}
          </div>
        )}

        {!loading && bookmarks.length > 0 && viewMode === 'grid' && (
          <div className="masonry-grid">
            {bookmarks.map((bookmark) => (
              <div key={bookmark.id} className="masonry-item">
                <BookmarkCard bookmark={bookmark} />
              </div>
            ))}
          </div>
        )}

        {!loading && bookmarks.length > 0 && viewMode === 'list' && (
          <div className="mx-auto flex max-w-4xl flex-col gap-4">
            {bookmarks.map((bookmark) => (
              <BookmarkCard key={bookmark.id} bookmark={bookmark} />
            ))}
          </div>
        )}

        <Pagination
          page={filters.page}
          total={total}
          limit={PAGE_SIZE}
          onChange={(nextPage) => setFilters((prev) => ({ ...prev, page: nextPage }))}
        />
      </div>
    </div>
  )
}

export default function BookmarksPage() {
  return (
    <Suspense>
      <BookmarksPageInner />
    </Suspense>
  )
}
