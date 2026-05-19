import { assert, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
