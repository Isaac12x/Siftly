import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import prisma from '@/lib/db'

// In-memory PKCE store (single-server SQLite app)
const pkceStore = new Map<string, { verifier: string; createdAt: number }>()

// Clean up stale entries older than 10 minutes
function cleanupPkce() {
  const cutoff = Date.now() - 10 * 60 * 1000
  for (const [key, val] of pkceStore) {
    if (val.createdAt < cutoff) pkceStore.delete(key)
  }
}

export { pkceStore }

function base64url(buf: Buffer): string {
  return buf.toString('base64url')
}

export async function GET(request: NextRequest) {
  try {
    cleanupPkce()

    const [clientIdSetting, clientSecretSetting] = await Promise.all([
      prisma.setting.findUnique({ where: { key: 'x_oauth_client_id' } }),
      prisma.setting.findUnique({ where: { key: 'x_oauth_client_secret' } }),
    ])

    const clientId = clientIdSetting?.value?.trim()
    if (!clientId || !clientSecretSetting?.value?.trim()) {
      return NextResponse.json(
        { error: 'X OAuth client credentials not configured. Add them in Settings.' },
        { status: 400 },
      )
    }

    // PKCE
    const codeVerifier = base64url(crypto.randomBytes(32))
    const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest())

    // State token to prevent CSRF
    const state = base64url(crypto.randomBytes(16))
    pkceStore.set(state, { verifier: codeVerifier, createdAt: Date.now() })

    // Build callback URL from request origin
    const origin = request.nextUrl.origin
    const redirectUri = `${origin}/api/import/x-oauth/callback`

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'bookmark.read tweet.read users.read offline.access',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })

    const authUrl = `https://twitter.com/i/oauth2/authorize?${params.toString()}`
    return NextResponse.json({ authUrl })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to start OAuth' },
      { status: 500 },
    )
  }
}
