import { assert, test } from 'vitest'
import * as articleModule from '../lib/article-extractor'

const articleExtractor = ('default' in articleModule ? articleModule.default : articleModule) as typeof import('../lib/article-extractor')
const {
  buildArticleImportFields,
  extractArticleUrlsFromRawJson,
  extractEmbeddedArticleContentFromRawJson,
} = articleExtractor as typeof import('../lib/article-extractor')

test('extracts quoted X Article links and embedded content', () => {
  const rawJson = JSON.stringify({
    rest_id: '111',
    legacy: { full_text: 'Commentary on top of a quoted article' },
    quoted_status_result: {
      result: {
        rest_id: '222',
        article: {
          article_results: {
            result: {
              rest_id: '987654321',
              title: 'Quoted Article Title',
              content: 'This is the quoted article body that should drive search and previews.',
              preview_image: {
                url: 'https://pbs.twimg.com/media/example?format=jpg&name=small',
              },
            },
          },
        },
      },
    },
  })

  assert.deepEqual(extractArticleUrlsFromRawJson(rawJson), [
    'https://x.com/i/article/987654321',
  ])

  const embedded = extractEmbeddedArticleContentFromRawJson(rawJson)
  assert.equal(embedded?.url, 'https://x.com/i/article/987654321')
  assert.match(embedded?.content ?? '', /Quoted Article Title/)
  assert.match(embedded?.content ?? '', /quoted article body/)
})

test('extracts external article URLs from quoted card values without media assets', () => {
  const rawJson = JSON.stringify({
    legacy: { full_text: 'Commentary on top of a linked article' },
    quoted_status_result: {
      result: {
        card: {
          legacy: {
            binding_values: {
              card_url: { string_value: 'https://example.com/story#section' },
              thumbnail_image: {
                image_value: {
                  url: 'https://pbs.twimg.com/media/example?format=jpg&name=small',
                },
              },
            },
          },
        },
      },
    },
  })

  assert.deepEqual(extractArticleUrlsFromRawJson(rawJson), [
    'https://example.com/story',
  ])
})

test('preserves the first article URL even when content fetching fails', () => {
  assert.deepEqual(
    buildArticleImportFields(['https://example.com/story'], null),
    { articleUrl: 'https://example.com/story', articleContent: '' },
  )

  assert.deepEqual(
    buildArticleImportFields([], null),
    { articleUrl: null, articleContent: null },
  )

  assert.deepEqual(
    buildArticleImportFields(
      ['https://example.com/story'],
      { url: 'https://publisher.example/final', content: 'Fetched article content' },
    ),
    { articleUrl: 'https://publisher.example/final', articleContent: 'Fetched article content' },
  )
})
