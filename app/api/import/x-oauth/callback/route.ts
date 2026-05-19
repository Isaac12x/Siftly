import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { pkceStore } from '../authorize/route'

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  const importUrl = new URL('/import', request.nextUrl.origin)

  if (error) {
    importUrl.searchParams.set('x_error', error)
    return NextResponse.redirect(importUrl)
  }

  if (!code || !state) {
    importUrl.searchParams.set('x_error', 'Missing code or state parameter')
    return NextResponse.redirect(importUrl)
  }

  // Verify PKCE state
  const pkce = pkceStore.get(state)
  if (!pkce) {
    importUrl.searchParams.set('x_error', 'Invalid or expired OAuth state')
    return NextResponse.redirect(importUrl)
  }
  pkceStore.delete(state)

  try {
    const [clientIdSetting, clientSecretSetting] = await Promise.all([
      prisma.setting.findUnique({ where: { key: 'x_oauth_client_id' } }),
      prisma.setting.findUnique({ where: { key: 'x_oauth_client_secret' } }),
    ])

    const clientId = clientIdSetting?.value?.trim()
    const clientSecret = clientSecretSetting?.value?.trim()
    if (!clientId || !clientSecret) {
      importUrl.searchParams.set('x_error', 'OAuth credentials missing')
      return NextResponse.redirect(importUrl)
    }

    const redirectUri = `${request.nextUrl.origin}/api/import/x-oauth/callback`

    // Exchange authorization code for tokens
    const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code_verifier: pkce.verifier,
      }),
    })

    if (!tokenRes.ok) {
      const text = await tokenRes.text()
      console.error('[x-oauth] Token exchange failed:', text)
      importUrl.searchParams.set('x_error', `Token exchange failed (${tokenRes.status})`)
      return NextResponse.redirect(importUrl)
    }

    const tokens = await tokenRes.json()
    const { access_token, refresh_token } = tokens

    if (!access_token) {
      importUrl.searchParams.set('x_error', 'No access token received')
      return NextResponse.redirect(importUrl)
    }

    // Fetch user info
    const userRes = await fetch('https://api.twitter.com/2/users/me', {
      headers: { Authorization: `Bearer ${access_token}` },
    })

    let userId = '', userName = '', userHandle = ''
    if (userRes.ok) {
      const userData = await userRes.json()
      userId = userData.data?.id ?? ''
      userName = userData.data?.name ?? ''
      userHandle = userData.data?.username ?? ''
    }

    // Store tokens and user info
    const settings = [
      { key: 'x_oauth_access_token', value: access_token },
      ...(refresh_token ? [{ key: 'x_oauth_refresh_token', value: refresh_token }] : []),
      ...(userId ? [{ key: 'x_oauth_user_id', value: userId }] : []),
      ...(userName ? [{ key: 'x_oauth_user_name', value: userName }] : []),
      ...(userHandle ? [{ key: 'x_oauth_user_handle', value: userHandle }] : []),
    ]

    await Promise.all(
      settings.map((s) =>
        prisma.setting.upsert({
          where: { key: s.key },
          update: { value: s.value },
          create: { key: s.key, value: s.value },
        }),
      ),
    )

    importUrl.searchParams.set('x_connected', 'true')
    return NextResponse.redirect(importUrl)
  } catch (err) {
    console.error('[x-oauth] Callback error:', err)
    importUrl.searchParams.set('x_error', err instanceof Error ? err.message : 'OAuth callback failed')
    return NextResponse.redirect(importUrl)
  }
}
