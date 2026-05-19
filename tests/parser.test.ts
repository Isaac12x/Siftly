import { assert, test } from 'vitest'
import * as articleModule from '../lib/article-extractor'
import * as parserModule from '../lib/parser'

const { extractArticleUrlsFromRawJson } = ('default' in articleModule ? articleModule.default : articleModule) as typeof import('../lib/article-extractor')
const { parseBookmarksJson } = ('default' in parserModule ? parserModule.default : parserModule) as typeof import('../lib/parser')

test('console exports preserve raw quoted article payloads for article extraction', () => {
  const raw = {
    rest_id: '111',
    legacy: { full_text: 'Commentary on top of a quoted article' },
    quoted_status_result: {
      result: {
        article: {
          article_results: {
            result: {
              rest_id: '987654321',
              title: 'Quoted Article Title',
              content: 'The article body is embedded in the quoted payload.',
            },
          },
        },
      },
    },
  }

  const parsed = parseBookmarksJson(JSON.stringify({
    source: 'bookmark',
    bookmarks: [{
      id: '111',
      author: 'Author',
      handle: '@author',
      timestamp: 'Mon May 11 12:00:00 +0000 2026',
      text: 'Commentary on top of a quoted article',
      urls: [],
      media: [],
      raw,
    }],
  }))

  assert.equal(parsed.length, 1)
  assert.deepEqual(extractArticleUrlsFromRawJson(parsed[0].rawJson), [
    'https://x.com/i/article/987654321',
  ])
})
