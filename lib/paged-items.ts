interface ItemWithId {
  id: string
}

export function mergePagedItemsById<T extends ItemWithId>(existing: T[], incoming: T[]): T[] {
  if (existing.length === 0) return incoming
  if (incoming.length === 0) return existing

  const next = [...existing]
  const indexById = new Map(existing.map((item, index) => [item.id, index]))

  for (const item of incoming) {
    const existingIndex = indexById.get(item.id)
    if (existingIndex === undefined) {
      indexById.set(item.id, next.length)
      next.push(item)
    } else {
      next[existingIndex] = item
    }
  }

  return next
}

export function hasMorePagedItems(loadedCount: number, totalCount: number): boolean {
  return loadedCount < totalCount
}
