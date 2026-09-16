import {
  insertPriceSnapshot,
  latestPriceSnapshots,
  listItems,
  listMyListings,
  replaceMyListings,
  type PriceSnapshotRow,
} from './db'
import { priceOverview } from './steam'
import { providers } from './price'
import * as steam from './steam'

export interface SyncStatus {
  running: boolean
  startedAt: string | null
  phase: 'idle' | 'inventory' | 'listings' | 'prices'
  current: number
  total: number
  last: { inventory: string | null; listings: string | null; prices: string | null }
  errors: string[]
}

export interface GridItem {
  assetid: string
  contextid: string
  name: string
  market_hash_name: string
  icon_url: string
  marketable: boolean
  marketable_restriction?: string | null
  rarity: { internal_name: string | null; name: string | null; rank: number } | null
  prices: Record<string, PriceSnapshotRow>
  listing: { listingid: string; price_cents: number | null } | null
}

export interface GridResponse {
  refreshedAt: string | null
  counts: { inventory: number; marketable: number; listed: number }
  sync: SyncStatus
  items: GridItem[]
}

interface InventoryRawFields {
  marketable_restriction?: string | number
  tags?: Array<{ internal_name: string; name: string; category: string; color?: string }>
}

interface RarityClass {
  key: string
  label: string
  rank: number
}

// Steam uses separate tag names for weapon rarities (Rarity_*_Weapon) and
// charm/other-item rarities (Rarity_*) that represent the same class:
//   Mil-Spec     = High Grade
//   Restricted   = Remarkable
//   Classified   = Exotic
//   Covert       = Extraordinary
// Group by class so e.g. all "Mil-Spec / High Grade" items live in one group.
const RARITY_CLASS: Record<string, RarityClass> = {
  Rarity_Contraband: { key: 'contraband', label: 'Contraband', rank: 0 },
  Rarity_Ancient_Weapon: { key: 'covert-extraordinary', label: 'Covert / Extraordinary', rank: 1 },
  Rarity_Ancient: { key: 'covert-extraordinary', label: 'Covert / Extraordinary', rank: 1 }, // knives, gloves, charm Extraordinary
  Rarity_Legendary_Weapon: { key: 'classified-exotic', label: 'Classified / Exotic', rank: 2 },
  Rarity_Legendary: { key: 'classified-exotic', label: 'Classified / Exotic', rank: 2 }, // charm Exotic
  Rarity_Mythical_Weapon: { key: 'restricted-remarkable', label: 'Restricted / Remarkable', rank: 3 },
  Rarity_Mythical: { key: 'restricted-remarkable', label: 'Restricted / Remarkable', rank: 3 }, // charm Remarkable
  Rarity_Rare_Weapon: { key: 'mil-spec-high-grade', label: 'Mil-Spec / High Grade', rank: 4 },
  Rarity_Rare: { key: 'mil-spec-high-grade', label: 'Mil-Spec / High Grade', rank: 4 }, // charm High Grade
  Rarity_Uncommon_Weapon: { key: 'industrial', label: 'Industrial Grade', rank: 5 },
  Rarity_Common_Weapon: { key: 'consumer', label: 'Consumer Grade', rank: 6 },
  Rarity_Common: { key: 'base', label: 'Base Grade', rank: 7 },
  Rarity_Default_Weapon: { key: 'stock', label: 'Stock', rank: 8 },
}

function parseRarity(raw: InventoryRawFields): GridItem['rarity'] {
  const tag = raw.tags?.find((t) => t.category === 'Rarity')
  if (!tag?.internal_name) return null
  const cls = RARITY_CLASS[tag.internal_name]
  if (!cls) return { internal_name: tag.internal_name, name: tag.name ?? null, rank: 99 }
  return { internal_name: cls.key, name: cls.label, rank: cls.rank }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const MAX_ITEMS_PER_SYNC = Number(process.env.SYNC_MAX_ITEMS ?? 100)
const PRICE_DELAY_MS = Number(process.env.SYNC_PRICE_DELAY_MS ?? 1000)
// Steam's price endpoint throttles aggressively (undocumented, burst-based).
// 6h keeps normal usage comfortably under it; override with SYNC_PRICE_FRESH_MS.
const PRICE_FRESH_MS = Number(process.env.SYNC_PRICE_FRESH_MS ?? 6 * 60 * 60_000)
const PRICE_429_ABORT = Number(process.env.SYNC_PRICE_429_ABORT ?? 3)

class SyncEngine {
  private running = false
  private startedAt: string | null = null
  private phase: SyncStatus['phase'] = 'idle'
  private current = 0
  private total = 0
  private last: SyncStatus['last'] = { inventory: null, listings: null, prices: null }
  private errors: string[] = []
  private readonly MAX_ERRORS = 20

  private pushError(message: string): void {
    this.errors.push(message)
    if (this.errors.length > this.MAX_ERRORS) this.errors.splice(0, this.errors.length - this.MAX_ERRORS)
  }

  status(): SyncStatus {
    return {
      running: this.running,
      startedAt: this.startedAt,
      phase: this.phase,
      current: this.current,
      total: this.total,
      last: { ...this.last },
      errors: [...this.errors],
    }
  }

  async syncAll(): Promise<boolean> {
    if (this.running) return false
    if (!steam.authStatus().loggedIn) return false

    this.running = true
    this.startedAt = new Date().toISOString()
    this.errors = []
    try {
      await this.syncInventory()
      await this.syncListings()
      await this.syncPrices()
    } finally {
      this.running = false
      this.phase = 'idle'
      this.startedAt = null
    }
    return true
  }

  private async syncInventory(): Promise<void> {
    this.phase = 'inventory'
    this.current = 1
    this.total = 1
    try {
      const { items } = await steam.getInventory()
      this.last.inventory = new Date().toISOString()
      console.info(`[sync] inventory: ${items.length} items`)
    } catch (err) {
      this.last.inventory = null
      this.pushError(`inventory: ${(err as Error).message}`)
      console.warn('[sync] inventory failed', (err as Error).message)
    }
  }

  private async syncListings(): Promise<void> {
    this.phase = 'listings'
    this.current = 1
    this.total = 1
    try {
      const { listings } = await steam.getMyListings()
      const previous = listMyListings().length
      if (listings.length === 0 && previous > 0) {
        // Steam can transiently return "no listings" (HTTP 400 / empty body)
        // while real listings still exist — never let that wipe the table.
        this.pushError('listings: Steam returned no listings but we previously had some — kept previous data')
        console.warn('[sync] listings came back empty while we had rows; keeping previous data')
        return
      }
      replaceMyListings(
        listings.map((l) => ({
          listingid: l.listingid,
          assetid: l.assetid ?? '',
          market_hash_name: l.market_hash_name ?? l.name ?? '',
          price_cents: l.price_cents ?? null,
          updated_at: new Date().toISOString(),
        })),
      )
      this.last.listings = new Date().toISOString()
      console.info(`[sync] listings: ${listings.length} active`)
    } catch (err) {
      this.last.listings = null
      this.pushError(`listings: ${(err as Error).message}`)
      console.warn('[sync] listings failed', (err as Error).message)
    }
  }

  private async syncPrices(): Promise<void> {
    const now = Date.now()
    const listedHashes = [...new Set(listMyListings().map((l) => l.market_hash_name).filter((h): h is string => !!h))]
    const listedSet = new Set(listedHashes)

    // Refresh prices only for hashes whose newest snapshot is stale. Listed
    // items are sorted first so they refresh before non-listed ones at the cap,
    // but respect the same freshness window — a back-to-back sync is a no-op.
    const { byItem } = latestPriceSnapshots()
    const freshAt = (hash: string): number => {
      const row = byItem.get(hash)?.get('steam')
      return row?.fetched_at ? new Date(row.fetched_at).getTime() : 0
    }
    const stale = (hash: string): boolean => now - freshAt(hash) > PRICE_FRESH_MS

    const candidates = [
      ...new Set(
        listItems()
          .filter((i) => i.marketable === 1 || listedSet.has(i.market_hash_name))
          .map((i) => i.market_hash_name),
      ),
    ].filter((h): h is string => !!h)
    const toPrice = candidates
      .filter(stale)
      .sort((a, b) => {
        const la = listedSet.has(a) ? 0 : 1
        const lb = listedSet.has(b) ? 0 : 1
        return la - lb || freshAt(a) - freshAt(b)
      })
      .slice(0, MAX_ITEMS_PER_SYNC)

    if (toPrice.length === 0) {
      this.last.prices = new Date().toISOString()
      console.info('[sync] prices already fresh — nothing to refresh')
      return
    }

    this.phase = 'prices'
    this.current = 0
    this.total = toPrice.length
    const csfloat = providers.find((p) => p.name === 'csfloat')
    let okCount = 0
    let consecutive429 = 0

    for (const hash of toPrice) {
      this.current++
      try {
        const ov = await priceOverview(hash)
        consecutive429 = 0
        insertPriceSnapshot({
          market_hash_name: hash,
          provider: 'steam',
          lowest_cents: ov.lowest_cents,
          median_cents: ov.success ? ov.median_cents : null,
          volume: ov.volume,
          had_error: ov.success ? 0 : 1,
          note: ov.success ? undefined : 'no listing data',
        })
        if (ov.success) okCount++
      } catch (err) {
        consecutive429++
        this.pushError(`price ${hash}: ${(err as Error).message}`)
        console.warn(`[sync] price ${hash} failed`, (err as Error).message)
        if (consecutive429 >= PRICE_429_ABORT && /429/.test((err as Error).message)) {
          this.pushError(`prices: Steam rate-limited after ${consecutive429} straight 429s — price refresh aborted`)
          console.warn(`[sync] prices: ${consecutive429} straight 429s — aborting price phase`)
          break
        }
      }

      if (csfloat) {
        try {
          const res = await csfloat.getItem(hash)
          insertPriceSnapshot({
            market_hash_name: hash,
            provider: 'csfloat',
            lowest_cents: res.lowest_cents,
            volume: res.volume,
            had_error: res.error ? 1 : 0,
            note: res.error,
          })
        } catch (err) {
          this.pushError(`csfloat ${hash}: ${(err as Error).message}`)
        }
      }

      await sleep(PRICE_DELAY_MS)
    }

    this.last.prices = new Date().toISOString()
    const aborted = consecutive429 >= PRICE_429_ABORT
    console.info(
      `[sync] prices: ${okCount}/${this.current} steam hashes snapshotted in this pass${aborted ? ' (aborted early on 429s)' : ''}, ${candidates.length - toPrice.length} fresh skipped`,
    )
  }
}

export const sync = new SyncEngine()

export function buildGrid(): GridResponse {
  const { byItem, latestAt } = latestPriceSnapshots()
  // Active listings are matched by market hash name: listing assetids can go
  // stale (orphaned listings), so an exact assetid join would miss them.
  const listings = listMyListings()
  const byHash = new Map<string, { listingid: string; price_cents: number | null }>()
  for (const l of listings.sort((a, b) => (a.price_cents ?? Infinity) - (b.price_cents ?? Infinity))) {
    if (l.market_hash_name && !byHash.has(l.market_hash_name)) {
      byHash.set(l.market_hash_name, { listingid: l.listingid, price_cents: l.price_cents })
    }
  }

  const all = listItems()
  // Steam reports marketable=0 for items that left the active inventory
  // context (context 16 — currently listed/on-market items), even though they
  // are sellable. An item with an active listing is by definition saleable, so
  // treat that as marketable.
  const marketable = all.filter((i) => i.marketable === 1 || byHash.has(i.market_hash_name))

  const items: GridItem[] = marketable
    .map((i) => {
      let raw: InventoryRawFields = {}
      try {
        raw = JSON.parse(i.raw) as InventoryRawFields
      } catch {
        /* ignore legacy rows */
      }
      const listing = byHash.get(i.market_hash_name)
      return {
        assetid: i.assetid,
        contextid: i.contextid ?? '2',
        name: i.name ?? i.market_hash_name,
        market_hash_name: i.market_hash_name,
        icon_url: i.icon_url ?? '',
        marketable: i.marketable === 1,
        marketable_restriction: typeof raw.marketable_restriction === 'number' ? String(raw.marketable_restriction) : raw.marketable_restriction,
        rarity: parseRarity(raw),
        prices: Object.fromEntries(byItem.get(i.market_hash_name) ?? []),
        listing: listing ? { listingid: listing.listingid, price_cents: listing.price_cents } : null,
      }
    })
    .sort(
      (a, b) =>
        (a.rarity?.rank ?? 99) - (b.rarity?.rank ?? 99) || a.market_hash_name.localeCompare(b.market_hash_name),
    )

  return {
    refreshedAt: latestAt,
    counts: { inventory: all.length, marketable: marketable.length, listed: listings.length },
    sync: sync.status(),
    items,
  }
}