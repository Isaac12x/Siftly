import { NextResponse } from 'next/server'
import prisma from '@/lib/db'

const OAUTH_KEYS = [
  'x_oauth_access_token',
  'x_oauth_refresh_token',
  'x_oauth_user_id',
  'x_oauth_user_name',
  'x_oauth_user_handle',
]

export async function POST() {
  try {
    await prisma.setting.deleteMany({
      where: { key: { in: OAUTH_KEYS } },
    })

    return NextResponse.json({ disconnected: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to disconnect' },
      { status: 500 },
    )
  }
}
