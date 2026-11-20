// Search and status filter for the inventory grid.

import { wearOf } from './format'
import { canSell, itemState, type ListingStateInput } from './itemState'

export type StatusFilter = 'all' | 'sellable' | 'listed' | 'awaiting' | 'restricted'

export const STATUS_FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: 'all', label: 'All but locked' },
  { id: 'sellable', label: 'Sellable' },
  { id: 'listed', label: 'Listed' },
  { id: 'awaiting', label: 'Awaiting' },
  { id: 'restricted', label: 'Locked' },
]

export interface FilterableItem extends ListingStateInput {
  name: string
  market_hash_name: string
  rarity?: { name?: string | null } | null
  own?: { stickers: string | null } | null
}

/** Everything a search word may match: name, wear (also as FN/MW/…), rarity, attached stickers and charms. */
function haystack(item: FilterableItem): string {
  const wear = wearOf(item.market_hash_name)
  const initials = wear
    .split(/[\s-]+/)
    .map((w) => w[0] ?? '')
    .join('')
  const attached: string[] = []
  try {
    const own = item.own?.stickers ? (JSON.parse(item.own.stickers) as { stickers?: unknown; keychains?: unknown }) : null
    for (const list of [own?.stickers, own?.keychains]) {
      if (Array.isArray(list)) for (const a of list) if (typeof a?.name === 'string') attached.push(a.name)
    }
  } catch {
    /* malformed sticker payload: search the rest */
  }
  return [item.name, item.market_hash_name, wear, initials, item.rarity?.name ?? '', ...attached].join(' ').toLowerCase()
}

function matchesStatus(item: FilterableItem, status: StatusFilter): boolean {
  // Locked items can't be sold yet, so they only show under their own filter.
  if (status === 'all') return itemState(item) !== 'restricted'
  if (status === 'sellable') return canSell(item)
  return itemState(item) === status
}

/** Items matching every word of `query` (any order, case-insensitive, from the start of a word) and the status. */
export function filterItems<T extends FilterableItem>(items: readonly T[], query: string, status: StatusFilter): T[] {
  // Each word must start a word in the item ("ak" finds AK-47, not StatTrak).
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => new RegExp('(?:^|[^\\p{L}\\p{N}])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'))
  return items.filter((item) => {
    if (!matchesStatus(item, status)) return false
    if (words.length === 0) return true
    const hay = haystack(item)
    return words.every((w) => w.test(hay))
  })
}
