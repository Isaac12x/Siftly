import { assert, test } from 'vitest'
import { hasMorePagedItems, mergePagedItemsById } from '../lib/paged-items'

test('mergePagedItemsById appends new pages while preserving existing item order', () => {
  const merged = mergePagedItemsById(
    [{ id: 'a' }, { id: 'b' }],
    [{ id: 'c' }, { id: 'd' }],
  )

  assert.deepEqual(merged.map((item) => item.id), ['a', 'b', 'c', 'd'])
})

test('mergePagedItemsById replaces duplicates from later pages without moving existing entries', () => {
  const merged = mergePagedItemsById(
    [{ id: 'a', value: 'old' }, { id: 'b', value: 'unchanged' }],
    [{ id: 'a', value: 'new' }, { id: 'c', value: 'added' }],
  )

  assert.deepEqual(merged, [
    { id: 'a', value: 'new' },
    { id: 'b', value: 'unchanged' },
    { id: 'c', value: 'added' },
  ])
})

test('hasMorePagedItems uses loaded count and total count', () => {
  assert.equal(hasMorePagedItems(24, 25), true)
  assert.equal(hasMorePagedItems(25, 25), false)
})
