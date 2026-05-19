import { NextResponse } from 'next/server'
import prisma from '@/lib/db'

export async function GET() {
  try {
    const [clientId, clientSecret, accessToken, refreshToken, userId, userName, userHandle, pendingCursor, lastSync] =
      await Promise.all([
        prisma.setting.findUnique({ where: { key: 'x_oauth_client_id' } }),
        prisma.setting.findUnique({ where: { key: 'x_oauth_client_secret' } }),
        prisma.setting.findUnique({ where: { key: 'x_oauth_access_token' } }),
        prisma.setting.findUnique({ where: { key: 'x_oauth_refresh_token' } }),
        prisma.setting.findUnique({ where: { key: 'x_oauth_user_id' } }),
        prisma.setting.findUnique({ where: { key: 'x_oauth_user_name' } }),
        prisma.setting.findUnique({ where: { key: 'x_oauth_user_handle' } }),
        prisma.setting.findUnique({ where: { key: 'x_oauth_fetch_cursor' } }),
        prisma.setting.findUnique({ where: { key: 'x_last_sync' } }),
      ])

    const configured = !!(clientId?.value && clientSecret?.value)
    const connected = !!(accessToken?.value)

    return NextResponse.json({
      configured,
      connected,
      user: connected
        ? { id: userId?.value, name: userName?.value, username: userHandle?.value }
        : null,
      tokenExpired: connected && !refreshToken?.value,
      incompleteFetch: !!pendingCursor?.value,
      lastSync: lastSync?.value ?? null,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to check status' },
      { status: 500 },
    )
  }
}
