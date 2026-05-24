import { assert, test, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'

function createDbMissingArticleColumns(dbPath: string): void {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE "Bookmark" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "tweetId" TEXT NOT NULL UNIQUE,
      "text" TEXT NOT NULL,
      "authorHandle" TEXT NOT NULL,
      "authorName" TEXT NOT NULL,
      "tweetCreatedAt" DATETIME,
      "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "rawJson" TEXT NOT NULL,
      "semanticTags" TEXT,
      "entities" TEXT,
      "enrichedAt" DATETIME,
      "enrichmentMeta" TEXT,
      "source" TEXT NOT NULL DEFAULT 'bookmark'
    );

    CREATE TABLE "ImportJob" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "filename" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "totalCount" INTEGER NOT NULL DEFAULT 0,
      "processedCount" INTEGER NOT NULL DEFAULT 0,
      "errorMessage" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  db.close()
}

function createFullImportDb(dbPath: string): void {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE "Bookmark" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "tweetId" TEXT NOT NULL UNIQUE,
      "text" TEXT NOT NULL,
      "authorHandle" TEXT NOT NULL,
      "authorName" TEXT NOT NULL,
      "tweetCreatedAt" DATETIME,
      "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "rawJson" TEXT NOT NULL,
      "articleUrl" TEXT,
      "articleContent" TEXT,
      "semanticTags" TEXT,
      "entities" TEXT,
      "enrichedAt" DATETIME,
      "enrichmentMeta" TEXT,
      "source" TEXT NOT NULL DEFAULT 'bookmark'
    );

    CREATE TABLE "MediaItem" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "bookmarkId" TEXT NOT NULL,
      "type" TEXT NOT NULL,
      "url" TEXT NOT NULL,
      "thumbnailUrl" TEXT,
      "localPath" TEXT,
      "imageTags" TEXT,
      CONSTRAINT "MediaItem_bookmarkId_fkey" FOREIGN KEY ("bookmarkId") REFERENCES "Bookmark" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );

    CREATE TABLE "ImportJob" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "filename" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "totalCount" INTEGER NOT NULL DEFAULT 0,
      "processedCount" INTEGER NOT NULL DEFAULT 0,
      "errorMessage" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  db.close()
}

test('import route reports insert failures separately from duplicate skips', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'siftly-import-route-'))
  const dbPath = join(dir, 'dev.db')
  createDbMissingArticleColumns(dbPath)
  process.env.DATABASE_URL = `file:${dbPath}`
  const originalError = console.error
  console.error = () => {}

  try {
    const routeModule = await import('../app/api/import/route')
    const post = (
      'default' in routeModule
        ? (routeModule.default as { POST?: typeof routeModule.POST }).POST
        : undefined
    ) ?? routeModule.POST

    const form = new FormData()
    form.append('source', 'bookmark')
    form.append('file', new File([
      JSON.stringify([
        {
          id: '2053035493869166927',
          full_text: 'New bookmark that cannot be inserted with a stale schema',
          created_at: '2026-05-09 09:52:59 +01:00',
        },
      ]),
    ], 'bookmarks.json', { type: 'application/json' }))

    const res = await post(new NextRequest('http://localhost/api/import', {
      method: 'POST',
      body: form,
    }))
    const body = await res.json()

    assert.equal(res.status, 500)
    assert.equal(body.imported, 0)
    assert.equal(body.skipped, 0)
    assert.equal(body.failed, 1)
    assert.match(body.error, /Failed to import 1 bookmark/)
  } finally {
    console.error = originalError
    rmSync(dir, { recursive: true, force: true })
  }
})

test('import route downloads imported images and videos', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'siftly-import-route-media-'))
  const dbPath = join(dir, 'dev.db')
  const mediaDir = join(dir, 'media-cache')
  createFullImportDb(dbPath)
  process.env.DATABASE_URL = `file:${dbPath}`
  process.env.SIFTLY_MEDIA_CACHE_DIR = mediaDir
  process.env.SIFTLY_MEDIA_PUBLIC_BASE = '/media-cache-test'
  vi.resetModules()

  const originalFetch = globalThis.fetch
  const fetchedUrls: string[] = []
  globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    fetchedUrls.push(url)
    if (url.includes('clip.mp4')) {
      return new Response(new Uint8Array([0, 1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      })
    }
    return new Response(new Uint8Array([4, 5, 6]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    })
  }

  try {
    const routeModule = await import('../app/api/import/route')
    const post = (
      'default' in routeModule
        ? (routeModule.default as { POST?: typeof routeModule.POST }).POST
        : undefined
    ) ?? routeModule.POST

    const form = new FormData()
    form.append('source', 'bookmark')
    form.append('file', new File([
      JSON.stringify([
        {
          id_str: '2053035493869166928',
          full_text: 'Bookmark with photo and video media',
          created_at: '2026-05-09 09:52:59 +01:00',
          user: { screen_name: 'siftly', name: 'Siftly' },
          extended_entities: {
            media: [
              {
                type: 'photo',
                media_url_https: 'https://pbs.twimg.com/media/photo?format=jpg&name=large',
              },
              {
                type: 'video',
                media_url_https: 'https://pbs.twimg.com/media/thumb.jpg',
                video_info: {
                  variants: [
                    {
                      content_type: 'video/mp4',
                      bitrate: 832000,
                      url: 'https://video.twimg.com/ext_tw_video/123/pu/vid/720x720/clip.mp4',
                    },
                  ],
                },
              },
            ],
          },
        },
      ]),
    ], 'bookmarks.json', { type: 'application/json' }))

    const res = await post(new NextRequest('http://localhost/api/import', {
      method: 'POST',
      body: form,
    }))
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.equal(body.imported, 1)
    assert.deepEqual(fetchedUrls, [
      'https://pbs.twimg.com/media/photo?format=jpg&name=large',
      'https://video.twimg.com/ext_tw_video/123/pu/vid/720x720/clip.mp4',
    ])

    const db = new Database(dbPath)
    const rows = db
      .prepare('SELECT type, url, thumbnailUrl, localPath FROM "MediaItem" ORDER BY type')
      .all() as Array<{ type: string; url: string; thumbnailUrl: string | null; localPath: string | null }>
    db.close()

    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((row) => row.type), ['photo', 'video'])
    for (const row of rows) {
      assert.ok(row.localPath)
      assert.match(row.localPath, /^\/media-cache-test\/2053035493869166928\/.+\.(jpg|mp4)$/)
      const filePath = join(mediaDir, '2053035493869166928', basename(row.localPath))
      assert.equal(existsSync(filePath), true)
      assert.equal(readFileSync(filePath).byteLength > 0, true)
    }
  } finally {
    globalThis.fetch = originalFetch
    delete process.env.SIFTLY_MEDIA_CACHE_DIR
    delete process.env.SIFTLY_MEDIA_PUBLIC_BASE
    rmSync(dir, { recursive: true, force: true })
  }
})
