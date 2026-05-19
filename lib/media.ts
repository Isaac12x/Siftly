const TWIMG_HOST_PATTERN = /(^|\.)twimg\.com$/i
const EXTRA_PROXY_HOSTS = new Set(['unavatar.io'])

export function proxyMediaUrl(url: string): string {
  return `/api/media?url=${encodeURIComponent(url)}`
}

export function isProxyableMediaUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url)
    return protocol === 'https:' && (
      TWIMG_HOST_PATTERN.test(hostname) ||
      EXTRA_PROXY_HOSTS.has(hostname)
    )
  } catch {
    return false
  }
}

export function buildMediaCandidates(...urls: Array<string | null | undefined>): string[] {
  const candidates: string[] = []

  for (const rawUrl of urls) {
    const url = rawUrl?.trim()
    if (!url) continue

    const nextValues = isProxyableMediaUrl(url)
      ? [proxyMediaUrl(url), url]
      : [url]

    for (const value of nextValues) {
      if (!candidates.includes(value)) {
        candidates.push(value)
      }
    }
  }

  return candidates
}
