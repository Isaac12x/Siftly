import { assert, test } from 'vitest'
import type { ParsedBookmark } from '../lib/parser'
import { planImportBookmarks } from '../lib/import-optimizer'
import { planEnrichmentTargets } from '../lib/vision-analyzer'
import { planTaxonomyDiscoveryBatches } from '../lib/categorizer'

function bookmark(tweetId: string): ParsedBookmark {
  return {
    tweetId,
    text: `Tweet ${tweetId}`,
    authorHandle: 'alice',
    authorName: 'Alice',
    tweetCreatedAt: null,
    hashtags: [],
    urls: [],
    media: [],
    rawJson: JSON.stringify({ id_str: tweetId }),
  }
}

test('planImportBookmarks skips existing and in-file duplicates in one pass', () => {
  const planned = planImportBookmarks(
    [bookmark('1'), bookmark('2'), bookmark('1'), bookmark('3'), bookmark('2')],
    new Set(['2']),
  )

  assert.deepEqual(planned.bookmarks.map((b) => b.tweetId), ['1', '3'])
  assert.equal(planned.skippedCount, 3)
})

test('planEnrichmentTargets batches non-trivial bookmarks and marks trivial rows', () => {
  const planned = planEnrichmentTargets([
    {
      id: 'short',
      text: 'ok',
      articleContent: null,
      entities: null,
      mediaItems: [],
    },
    {
      id: 'rich',
      text: 'A longer bookmark with useful context for semantic enrichment',
      articleContent: null,
      entities: '{"hashtags":["ai"],"tools":["Vercel"],"mentions":["openai"]}',
      mediaItems: [
        { imageTags: null },
        { imageTags: '{}' },
        { imageTags: '{"scene":"architecture diagram"}' },
      ],
    },
  ])

  assert.deepEqual(planned.trivialIds, ['short'])
  assert.equal(planned.targets.length, 1)
  assert.equal(planned.targets[0].id, 'rich')
  assert.deepEqual(planned.targets[0].imageTags, ['{"scene":"architecture diagram"}'])
  assert.deepEqual(planned.targets[0].entities?.hashtags, ['ai'])
  assert.deepEqual(planned.targets[0].entities?.tools, ['Vercel'])
})

test('planTaxonomyDiscoveryBatches caps large corpus discovery work', () => {
  const small = planTaxonomyDiscoveryBatches(120)
  assert.deepEqual(small, [
    { skip: 0, take: 80 },
    { skip: 80, take: 40 },
  ])

  const large = planTaxonomyDiscoveryBatches(2_000)
  assert.equal(large.length, 6)
  assert.equal(large.reduce((sum, batch) => sum + batch.take, 0), 480)
  assert.equal(large[0].skip, 0)
  assert.ok(large[large.length - 1].skip > 1_800)
})
