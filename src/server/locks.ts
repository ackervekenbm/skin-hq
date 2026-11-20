// When a temporarily locked item can be sold on the Market. Steam puts the
// date in the owner's item text, "Tradable/Marketable After …", either as a
// [date]<unix seconds>[/date] token or as text that steamcommunity already
// parses into `cache_expiration`. Items that can never be sold (medals,
// default graffiti, storage units) carry no such date.

interface LockSource {
  marketable?: boolean | number
  owner_descriptions?: Array<{ value?: string }>
  cache_expiration?: string
}

/** ISO time the item becomes marketable, or null when it already is or never will be. */
export function unlockDate(item: LockSource): string | null {
  if (item.marketable) return null
  for (const d of item.owner_descriptions ?? []) {
    if (!/after/i.test(d.value ?? '')) continue
    const token = /\[date\](\d+)\[\/date\]/.exec(d.value ?? '')
    if (token) return new Date(Number(token[1]) * 1000).toISOString()
  }
  const parsed = item.cache_expiration ? new Date(item.cache_expiration) : null
  return parsed && !isNaN(parsed.getTime()) ? parsed.toISOString() : null
}
