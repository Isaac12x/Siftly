import prisma from '@/lib/db'

const MAX_ARTICLE_CHARS = 12_000
const MIN_ARTICLE_CHARS = 400
const FETCH_TIMEOUT_MS = 10_000
const HTTP_URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g

const SKIP_HOST_PARTS = [
  'x.com',
  'twitter.com',
  't.co',
  'twimg.com',
  'youtube.com',
  'youtu.be',
  'instagram.com',
  'tiktok.com',
  'threads.net',
  'facebook.com',
  'linkedin.com',
  'github.com',
]

const SKIP_EXTENSIONS = /\.(?:jpg|jpeg|png|gif|webp|avif|svg|mp4|mov|webm|mp3|wav|pdf|zip)(?:[?#]|$)/i

export interface ArticleFetchResult {
  url: string
  content: string
}

export interface ArticleImportFields {
  articleUrl: string | null
  articleContent: string | null
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code)
      return Number.isFinite(n) ? String.fromCodePoint(n) : ''
    })
}

function cleanText(text: string): string {
  return decodeHtmlEntities(text)
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function isXArticleUrl(url: URL): boolean {
  const host = url.hostname.replace(/^www\./, '').toLowerCase()
  return (host === 'x.com' || host === 'twitter.com') && /^\/i\/article\/\d+\/?$/.test(url.pathname)
}

function isLikelyArticleUrl(rawUrl: string, options: { includeXArticles?: boolean } = {}): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (SKIP_EXTENSIONS.test(url.pathname)) return false
    if (options.includeXArticles && isXArticleUrl(url)) return true
    const host = url.hostname.replace(/^www\./, '').toLowerCase()
    return !SKIP_HOST_PARTS.some((part) => host === part || host.endsWith(`.${part}`))
  } catch {
    return false
  }
}

function normalizeCandidateUrl(rawUrl: string): string {
  return rawUrl
    .trim()
    .replace(/[.,;!?]+$/g, '')
    .replace(/#.*$/, '')
}

function uniqueArticleUrls(urls: string[], options: { includeXArticles?: boolean } = {}): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const rawUrl of urls) {
    const url = normalizeCandidateUrl(rawUrl)
    if (!url || !isLikelyArticleUrl(url, options)) continue
    const key = url
    if (seen.has(key)) continue
    seen.add(key)
    result.push(key)
  }
  return result
}

function extractHttpUrls(value: string): string[] {
  return value.match(HTTP_URL_REGEX) ?? []
}

function articleUrlFromObject(obj: Record<string, unknown>): string | null {
  const rawId = obj.rest_id ?? obj.id_str ?? obj.id
  if (rawId == null) return null

  const restId = String(rawId)
  if (!/^\d+$/.test(restId)) return null

  const looksLikeArticle =
    typeof obj.title === 'string' ||
    typeof obj.content === 'string' ||
    typeof obj.preview_text === 'string' ||
    obj.content_state != null ||
    obj.cover_media != null ||
    obj.preview_image != null

  return looksLikeArticle ? `https://x.com/i/article/${restId}` : null
}

function articleBlocksText(obj: Record<string, unknown>): string {
  const contentState = obj.content_state
  if (!contentState || typeof contentState !== 'object') return ''
  const blocks = (contentState as { blocks?: unknown }).blocks
  if (!Array.isArray(blocks)) return ''

  return blocks
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const text = (block as { text?: unknown }).text
      return typeof text === 'string' ? text.trim() : ''
    })
    .filter(Boolean)
    .join('\n\n')
}

function articleContentFromObject(obj: Record<string, unknown>): ArticleFetchResult | null {
  const url = articleUrlFromObject(obj)
  if (!url) return null

  const parts: string[] = []
  if (typeof obj.title === 'string') parts.push(obj.title)
  if (typeof obj.content === 'string') parts.push(obj.content)

  const blocks = articleBlocksText(obj)
  if (blocks) parts.push(blocks)

  if (parts.length === 0 && typeof obj.preview_text === 'string') {
    parts.push(obj.preview_text)
  }

  const content = cleanText(parts.join('\n\n')).slice(0, MAX_ARTICLE_CHARS)
  return content ? { url, content } : null
}

function walkJsonObjects(parsed: unknown, visit: (obj: Record<string, unknown>) => void, collectUrl?: (url: string) => void): void {
  const stack: unknown[] = [parsed]

  while (stack.length > 0) {
    const item = stack.shift()
    if (!item || typeof item !== 'object') continue

    if (Array.isArray(item)) {
      stack.push(...item)
      continue
    }

    const obj = item as Record<string, unknown>
    visit(obj)

    for (const value of Object.values(obj)) {
      if (typeof value === 'string') {
        collectUrl?.(value)
      } else if (Array.isArray(value)) {
        stack.push(...value)
      } else if (value && typeof value === 'object') {
        stack.push(value)
      }
    }
  }
}

function extractJsonLdArticleBody(html: string): string {
  const scripts = html.match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) ?? []
  for (const script of scripts) {
    const jsonText = script
      .replace(/^<script\b[^>]*>/i, '')
      .replace(/<\/script>$/i, '')
      .trim()
    try {
      const parsed = JSON.parse(decodeHtmlEntities(jsonText)) as unknown
      const stack = Array.isArray(parsed) ? [...parsed] : [parsed]
      while (stack.length > 0) {
        const item = stack.shift()
        if (!item || typeof item !== 'object') continue
        const obj = item as Record<string, unknown>
        if (typeof obj.articleBody === 'string') return obj.articleBody
        for (const value of Object.values(obj)) {
          if (Array.isArray(value)) stack.push(...value)
          else if (value && typeof value === 'object') stack.push(value)
        }
      }
    } catch {
      // Ignore malformed structured data.
    }
  }
  return ''
}

function htmlToArticleText(html: string): string {
  const structured = extractJsonLdArticleBody(html)
  if (structured.trim().length >= MIN_ARTICLE_CHARS) return cleanText(structured).slice(0, MAX_ARTICLE_CHARS)

  const articleMatch = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)
  const source = articleMatch?.[1] ?? html
  const paragraphs = Array.from(source.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi))
    .map((match) => match[1])
    .map((p) => p
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '))
    .map(cleanText)
    .filter((p) => p.length >= 40)

  const text = paragraphs.length > 0
    ? paragraphs.join('\n\n')
    : source
        .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
        .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ')
        .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
        .replace(/<aside\b[\s\S]*?<\/aside>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')

  return cleanText(text).slice(0, MAX_ARTICLE_CHARS)
}

export function extractArticleUrlsFromRawJson(rawJson: string): string[] {
  if (!rawJson) return []
  try {
    const parsed = JSON.parse(rawJson) as unknown
    const urls: string[] = []
    walkJsonObjects(
      parsed,
      (obj) => {
        const articleUrl = articleUrlFromObject(obj)
        if (articleUrl) urls.push(articleUrl)
      },
      (value) => urls.push(...extractHttpUrls(value)),
    )
    return uniqueArticleUrls(urls, { includeXArticles: true })
  } catch {
    return []
  }
}

export function extractEmbeddedArticleContentFromRawJson(rawJson: string): ArticleFetchResult | null {
  if (!rawJson) return null
  try {
    const parsed = JSON.parse(rawJson) as unknown
    let article: ArticleFetchResult | null = null
    walkJsonObjects(parsed, (obj) => {
      if (article) return
      article = articleContentFromObject(obj)
    })
    return article
  } catch {
    return null
  }
}

export function buildArticleImportFields(
  articleUrls: string[],
  article: ArticleFetchResult | null,
): ArticleImportFields {
  const fallbackUrl = uniqueArticleUrls(articleUrls, { includeXArticles: true })[0] ?? null

  return {
    articleUrl: article?.url || fallbackUrl,
    articleContent: article?.content ?? (fallbackUrl ? '' : null),
  }
}

export async function fetchFirstArticleContent(urls: string[]): Promise<ArticleFetchResult | null> {
  for (const url of uniqueArticleUrls(urls)) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'Mozilla/5.0 (compatible; Siftly/0.1; +https://github.com/viperrcrypto/Siftly)',
        },
      })
      if (!res.ok) continue
      const contentType = res.headers.get('content-type')?.toLowerCase() ?? ''
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) continue
      const html = await res.text()
      const content = htmlToArticleText(html)
      if (content.length >= MIN_ARTICLE_CHARS) {
        return { url: res.url || url, content }
      }
    } catch {
      // Many publisher sites block bots or require JS; keep import/enrichment moving.
    }
  }
  return null
}

export async function backfillArticleContent(
  onProgress?: (count: number) => void,
  shouldAbort?: () => boolean,
): Promise<number> {
  let processed = 0
  let cursor: string | undefined

  while (true) {
    if (shouldAbort?.()) break
    const rows = await prisma.bookmark.findMany({
      where: {
        articleContent: null,
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: 20,
      select: { id: true, rawJson: true, entities: true },
    })
    if (rows.length === 0) break
    cursor = rows[rows.length - 1].id

    for (const row of rows) {
      if (shouldAbort?.()) break
      let urls = extractArticleUrlsFromRawJson(row.rawJson)
      if (urls.length === 0 && row.entities) {
        try {
          const entities = JSON.parse(row.entities) as { urls?: string[] }
          urls = entities.urls ?? []
        } catch {
          // Ignore malformed entity cache.
        }
      }
      if (urls.length === 0) {
        await prisma.bookmark.update({
          where: { id: row.id },
          data: { articleContent: '' },
        })
        continue
      }
      const embeddedArticle = extractEmbeddedArticleContentFromRawJson(row.rawJson)
      const article = embeddedArticle ?? await fetchFirstArticleContent(urls)
      const articleFields = buildArticleImportFields(urls, article)
      if (articleFields.articleContent) {
        await prisma.bookmark.update({
          where: { id: row.id },
          data: articleFields,
        })
        processed++
        onProgress?.(processed)
      } else {
        await prisma.bookmark.update({
          where: { id: row.id },
          data: articleFields,
        })
      }
    }

    if (rows.length < 20) break
  }

  return processed
}
