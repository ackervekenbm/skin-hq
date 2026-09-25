export interface RarityGroup<T> {
  key: string
  label: string
  rank: number
  items: T[]
}

export function groupByRarity<T extends { rarity?: { internal_name?: string | null; name?: string | null; rank?: number } | null }>(
  items: T[],
): RarityGroup<T>[] {
  const groups = new Map<string, RarityGroup<T>>()
  for (const item of items) {
    const key = item.rarity?.internal_name ?? 'unranked'
    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        label: item.rarity?.name ?? 'Other',
        rank: item.rarity?.rank ?? 99,
        items: [],
      }
      groups.set(key, group)
    }
    group.items.push(item)
  }
  return Array.from(groups.values()).sort((a, b) => a.rank - b.rank)
}