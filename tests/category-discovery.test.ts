import { assert, test } from 'vitest'
import * as categorizerModule from '../lib/categorizer'

const categorizer = ('default' in categorizerModule ? categorizerModule.default : categorizerModule) as typeof import('../lib/categorizer')

test('default taxonomy does not hard-code niche user collections', () => {
  const slugs = new Set<string>(categorizer.DEFAULT_CATEGORIES.map((category) => category.slug))

  assert.equal(slugs.has('products-gear'), false)
  assert.equal(slugs.has('watches-horology'), false)
})

test('parseDiscoveredCategories normalizes LLM category proposals', () => {
  const parsed = categorizer.parseDiscoveredCategories(`
    Here are the categories:
    [
      {
        "name": "Products & Gear",
        "description": "Physical products, gadgets, desk setup items, bags, cameras, and product recommendations."
      },
      {
        "name": "Watches / Horology",
        "slug": "watches-horology",
        "description": "Watch collecting, brands, movements, dials, straps, auctions, and wrist shots."
      },
      {
        "name": "General",
        "description": "Everything else"
      }
    ]
  `)

  assert.deepEqual(parsed.map((category) => category.slug), [
    'products-gear',
    'watches-horology',
  ])
  assert.equal(parsed[0].name, 'Products & Gear')
  assert.match(parsed[1].description, /Watch collecting/)
})

test('buildCategoryDiscoveryPrompt includes bookmark signals for LLM taxonomy discovery', () => {
  const prompt = categorizer.buildCategoryDiscoveryPrompt([
    {
      tweetId: '1',
      text: 'Grand Seiko released a new GMT watch.',
      articleContent: 'The launch details the movement and case finishing.',
      semanticTags: ['watch collecting', 'grand seiko'],
      hashtags: ['horology'],
      tools: [],
    },
  ])

  assert.match(prompt, /Grand Seiko/)
  assert.match(prompt, /watch collecting/)
  assert.match(prompt, /Return ONLY valid JSON/)
})
