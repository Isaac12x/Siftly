import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_PUBLIC_BASE_PATH = '/media-cache'
const DEFAULT_MAX_MEDIA_BYTES = 200 * 1024 * 1024
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 20_000

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface ImportableMediaItem {
  type: string
  url: string
  thumbnailUrl?: string | null
}

export interface PreparedMediaItemImport {
  type: string
  url: string
  thumbnailUrl: string | null
  localPath: string | null
}

export interface PrepareMediaItemsOptions {
  tweetId?: string
  storageDir?: string
  publicBasePath?: string
  fetch?: FetchLike
  maxBytes?: number
  timeoutMs?: number
}

function mediaCacheDir(): string {
  return process.env.SIFTLY_MEDIA_CACHE_DIR?.trim() || path.join(process.cwd(), 'public', 'media-cache')
}

function mediaPublicBasePath(): string {
  return process.env.SIFTLY_MEDIA_PUBLIC_BASE?.trim() || DEFAULT_PUBLIC_BASE_PATH
}

function normalizePublicBasePath(basePath: string): string {
  const trimmed = basePath.trim()
  if (!trimmed) return DEFAULT_PUBLIC_BASE_PATH
  return `/${trimmed.replace(/^\/+/, '').replace(/\/+$/, '')}`
}

function safePathSegment(value: string | undefined): string {
  const cleaned = (value || 'unknown')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || 'unknown'
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (!host.includes('.') && host !== 'x.com') return true
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true

  const parts = host.split('.').map((part) => Number(part))
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b] = parts
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
  }

  return false
}

function isDownloadableMediaUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !isBlockedHostname(url.hostname)
  } catch {
    return false
  }
}

function extensionFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    const format = url.searchParams.get('format')?.toLowerCase()
    if (format === 'jpg' || format === 'jpeg') return '.jpg'
    if (format === 'png') return '.png'
    if (format === 'gif') return '.gif'
    if (format === 'webp') return '.webp'
    if (format === 'avif') return '.avif'

    const ext = path.extname(url.pathname).toLowerCase()
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.mp4', '.mov', '.webm'].includes(ext)) {
      return ext === '.jpeg' ? '.jpg' : ext
    }
  } catch {
    // Ignore malformed URLs; callers already validate before downloading.
  }
  return null
}

function extensionFromContentType(contentType: string, media: ImportableMediaItem): string {
  const lower = contentType.toLowerCase()
  if (lower.includes('video/mp4')) return '.mp4'
  if (lower.includes('video/quicktime')) return '.mov'
  if (lower.includes('video/webm')) return '.webm'
  if (lower.includes('image/png')) return '.png'
  if (lower.includes('image/gif')) return '.gif'
  if (lower.includes('image/webp')) return '.webp'
  if (lower.includes('image/avif')) return '.avif'
  if (lower.includes('image/jpeg') || lower.includes('image/jpg')) return '.jpg'

  const urlExt = extensionFromUrl(media.url)
  if (urlExt) return urlExt
  if (media.type === 'video' || media.type === 'gif') return '.mp4'
  return '.jpg'
}

function mediaHeaders(media: ImportableMediaItem): HeadersInit {
  const isVideo = media.type === 'video' || media.type === 'gif' || media.url.includes('.mp4')
  return {
    Accept: isVideo ? '*/*' : 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    Referer: 'https://x.com/',
    'User-Agent': 'Mozilla/5.0 (compatible; Siftly/0.2; +https://github.com/viperrcrypto/Siftly)',
  }
}

async function downloadMediaItem(
  media: ImportableMediaItem,
  options: Required<Pick<PrepareMediaItemsOptions, 'storageDir' | 'publicBasePath' | 'fetch' | 'maxBytes' | 'timeoutMs'>> & {
    tweetId: string
  },
): Promise<string | null> {
  if (!media.url || !isDownloadableMediaUrl(media.url)) return null

  try {
    const response = await options.fetch(media.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: mediaHeaders(media),
    })
    if (!response.ok) return null

    const contentLength = Number(response.headers.get('content-length') ?? 0)
    if (contentLength > options.maxBytes) return null

    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength === 0 || buffer.byteLength > options.maxBytes) return null

    const tweetSegment = safePathSegment(options.tweetId)
    const hash = createHash('sha256').update(media.url).digest('hex').slice(0, 20)
    const ext = extensionFromContentType(response.headers.get('content-type') ?? '', media)
    const filename = `${safePathSegment(media.type)}-${hash}${ext}`
    const outputDir = path.join(options.storageDir, tweetSegment)

    await mkdir(outputDir, { recursive: true })
    await writeFile(path.join(outputDir, filename), buffer)

    return `${normalizePublicBasePath(options.publicBasePath)}/${tweetSegment}/${filename}`
  } catch {
    return null
  }
}

export async function prepareMediaItemsForImport(
  mediaItems: ImportableMediaItem[],
  options: PrepareMediaItemsOptions = {},
): Promise<PreparedMediaItemImport[]> {
  const resolvedOptions = {
    tweetId: safePathSegment(options.tweetId),
    storageDir: options.storageDir ?? mediaCacheDir(),
    publicBasePath: options.publicBasePath ?? mediaPublicBasePath(),
    fetch: options.fetch ?? fetch,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
  }

  const prepared: PreparedMediaItemImport[] = []
  for (const media of mediaItems) {
    const localPath = await downloadMediaItem(media, resolvedOptions)
    prepared.push({
      type: media.type,
      url: media.url,
      thumbnailUrl: media.thumbnailUrl ?? null,
      localPath,
    })
  }
  return prepared
}
