import {
  insertPriceSnapshot,
  latestPriceSnapshots,
  listItems,
  listMyListings,
  replaceMyListings,
  type PriceSnapshotRow,
} from './db'
import type { ItemPrice } from './price'
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
  blockMessage: string | null
  completedRuns: number
  autoSyncMin: number | null
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
  own: { float_value: number; paint_seed: number; stickers: string | null } | null
  prices: Record<string, PriceSnapshotRow>
  listing: { listingid: string; price_cents: number | null } | null
  pricesSyncedAt: string | null
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

// Market names of charms mounted on owned weapons (the attached charm decodes
// to a keychain entry whose name maps to a "Charm | <name>" market listing).
export function attachedItemHashes(ownStickersRows: Array<string | null>): string[] {
  const hashes = new Set<string>()
  for (const raw of ownStickersRows) {
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw) as { keychains?: Array<{ name?: string | null }> }
      const name = parsed?.keychains?.[0]?.name
      if (name) hashes.add(`Charm | ${name}`)
    } catch {
      /* ignore unparseable rows */
    }
  }
  return [...hashes]
}

export function enrichOwnStickers(
  raw: string | null,
  byItem: Map<string, Map<string, PriceSnapshotRow>>,
): string | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as {
      stickers?: unknown[]
      keychains?: Array<{
        name?: string | null
        steam_cents?: number | null
        csfloat_cents?: number | null
        steam_median_cents?: number | null
        steam_buy_cents?: number | null
        steam_buy_count?: number | null
        steam_volume?: number | null
      }>
    }
    const keychain = parsed?.keychains?.[0]
    if (keychain?.name) {
      const snap = byItem.get(`Charm | ${keychain.name}`)
      if (snap) {
        keychain.steam_cents = snap.get('steam')?.lowest_cents ?? null
        keychain.csfloat_cents = snap.get('csfloat')?.lowest_cents ?? null
        keychain.steam_median_cents = snap.get('steam')?.median_cents ?? null
        keychain.steam_buy_cents = snap.get('steam')?.highest_buy_cents ?? null
        keychain.steam_buy_count = snap.get('steam')?.buy_count ?? null
        keychain.steam_volume = snap.get('steam')?.volume ?? null
      }
    }
    return JSON.stringify(parsed)
  } catch {
    return raw
  }
}

function parseRarity(raw: InventoryRawFields): GridItem['rarity'] {
  const tag = raw.tags?.find((t) => t.category === 'Rarity')
  if (!tag?.internal_name) return null
  const cls = RARITY_CLASS[tag.internal_name]
  if (!cls) return { internal_name: tag.internal_name, name: tag.name ?? null, rank: 99 }
  return { internal_name: cls.key, name: cls.label, rank: cls.rank }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Per-pass hard cap for the price phase; 0 (default) = price every currently
// stale hash, so a large first run fully prices the backlog instead of
// leaving most items waiting for later passes. Pacing + the 429 abort below
// keep a long drain Steam-friendly.
const MAX_ITEMS_PER_SYNC = Number(process.env.SYNC_MAX_ITEMS ?? 0)
const PRICE_DELAY_MS = Number(process.env.SYNC_PRICE_DELAY_MS ?? 1000)
// Steam's price endpoint throttles aggressively (undocumented, burst-based).
// 6h keeps normal usage comfortably under it; override with SYNC_PRICE_FRESH_MS.
const PRICE_FRESH_MS = Number(process.env.SYNC_PRICE_FRESH_MS ?? 6 * 60 * 60_000)
const PRICE_429_ABORT = Number(process.env.SYNC_PRICE_429_ABORT ?? 3)
// How often the server auto-syncs on its own (inventory, listings, prices) so
// an always-on deployment stays current without a manual "Sync now". 0 = no
// scheduled syncs. Syncs never overlap: a tick that lands while one is running
// is skipped, and the price phase is stale-gated (PRICE_FRESH_MS), so frequent
// cadences are cheap.
export const AUTO_SYNC_MIN = Number(process.env.SYNC_INTERVAL_MIN ?? 60)

class SyncEngine {
  private running = false
  private startedAt: string | null = null
  private phase: SyncStatus['phase'] = 'idle'
  private current = 0
  private total = 0
  private last: SyncStatus['last'] = { inventory: null, listings: null, prices: null }
  private errors: string[] = []
  private blockMessage: string | null = null
  private completedRuns = 0
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
      blockMessage: this.blockMessage,
      completedRuns: this.completedRuns,
      autoSyncMin: AUTO_SYNC_MIN > 0 ? AUTO_SYNC_MIN : null,
    }
  }

  async syncAll(): Promise<boolean> {
    if (this.running) return false
    if (!steam.authStatus().loggedIn) {
      this.blockMessage = 'Sign in to Steam first'
      return false
    }
    // Probe first so a silently-rejected session never reaches the market:
    // a force probe is one cheap GET and the only 'dead' outcome clears the
    // stored session (see steam.ts).
    const probe = await steam.probeSessionNow()
    if (probe === 'dead') {
      console.warn('[sync] aborted: Steam session was rejected — sign in again')
      this.blockMessage = 'Steam session expired — sign in again'
      return false
    }
    this.blockMessage = null
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
      this.completedRuns++
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
      // A session rejection usually surfaces here first — reclassify so the
      // running sync aborts downstream instead of grinding on a dead session.
      void steam.probeSessionNow()
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
      void steam.probeSessionNow()
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

    // Attached charms/stickers don't appear in the inventory listing (they
    // live on the weapon they are mounted to). Price them under their own
    // market name so the grid can show a "worth" on the weapon card. They are
    // also given pricing priority (after listed items) so a large inventory
    // can't starve the charm worth out of the per-sync price cap.
    const attachedCharmHashes = attachedItemHashes(listItems().map((i) => i.own_stickers ?? null))
    const attachedCharmSet = new Set(attachedCharmHashes)
    for (const hash of attachedCharmHashes) if (!candidates.includes(hash)) candidates.push(hash)
    const staleSorted = candidates
      .filter(stale)
      .sort((a, b) => {
        const priority = (h: string): number => (listedSet.has(h) ? 0 : attachedCharmSet.has(h) ? 1 : 2)
        return priority(a) - priority(b) || freshAt(a) - freshAt(b)
      })
    const toPrice = MAX_ITEMS_PER_SYNC > 0 ? staleSorted.slice(0, MAX_ITEMS_PER_SYNC) : staleSorted

    if (toPrice.length === 0) {
      this.last.prices = new Date().toISOString()
      console.info('[sync] prices already fresh — nothing to refresh')
      return
    }

    this.phase = 'prices'
    this.current = 0
    this.total = toPrice.length
    let okCount = 0
    let consecutive429 = 0
    let aborted = false

    const run = providers.length > 0
    if (!run) this.pushError('prices: no price providers configured')

    for (const hash of toPrice) {
      this.current++
      let hashOk = false
      for (const provider of providers) {
        let res: ItemPrice
        try {
          res = await provider.getItem(hash)
        } catch (err) {
          res = { provider: provider.name, currency: 'EUR', lowest_cents: null, error: (err as Error).message }
        }
        if (res.error) {
          this.pushError(`${provider.name} ${hash}: ${res.error}`)
          console.warn(`[sync] ${provider.name} ${hash} failed`, res.error)
          if (/429/.test(res.error)) {
            consecutive429++
            if (consecutive429 >= PRICE_429_ABORT) {
              this.pushError(`prices: Steam rate-limited after ${consecutive429} straight 429s — price refresh aborted`)
              console.warn(`[sync] prices: ${consecutive429} straight 429s — aborting price phase`)
              aborted = true
              break
            }
          } else {
            consecutive429 = 0
          }
        } else {
          consecutive429 = 0
          if (provider.name === 'steam') hashOk = true
        }
        insertPriceSnapshot({
          market_hash_name: hash,
          provider: provider.name,
          lowest_cents: res.lowest_cents,
          median_cents: res.median_cents ?? null,
          volume: res.volume,
          sell_count: res.sell_count,
          buy_count: res.buy_count,
          highest_buy_cents: res.highest_buy_cents,
          float_value: res.float_value,
          paint_seed: res.paint_seed,
          stickers: res.stickers ? JSON.stringify(res.stickers) : null,
          had_error: res.error ? 1 : 0,
          note: res.error,
        })
      }
      if (aborted) break
      if (hashOk) okCount++
      await sleep(PRICE_DELAY_MS)
    }

    this.last.prices = new Date().toISOString()
    console.info(
      `[sync] prices: ${okCount}/${this.current} steam hashes snapshotted in this pass${aborted ? ' (aborted early on 429s)' : ''}, ${candidates.length - toPrice.length} fresh skipped`,
    )
  }
}

export const sync = new SyncEngine()

// Schedules the server-side auto-sync. First run shortly after boot (so a
// restored session starts refreshing on its own), then every AUTO_SYNC_MIN.
// Disabled when SYNC_INTERVAL_MIN=0. Timers are unref'd so they never keep the
// process alive on their own.
export function startAutoSync(): void {
  if (!(AUTO_SYNC_MIN > 0)) {
    console.info('[sync] auto-sync disabled (SYNC_INTERVAL_MIN=0)')
    return
  }
  const tick = (): Promise<boolean> => autoSyncTick()
  const timer = setTimeout(() => {
    void tick()
    const loop = setInterval(() => void tick(), AUTO_SYNC_MIN * 60_000)
    loop.unref()
  }, 60_000)
  timer.unref()
  console.info(`[sync] auto-sync every ${AUTO_SYNC_MIN} min (SYNC_INTERVAL_MIN)`)
}

async function autoSyncTick(): Promise<boolean> {
  if (!steam.authStatus().loggedIn) return false
  if (sync.status().running) return false
  console.info('[sync] auto-sync starting')
  const ok = await sync.syncAll()
  console.info(`[sync] auto-sync ${ok ? 'finished' : 'skipped'}`)
  return ok
}

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
      // All providers for a hash are snapshotted in the same pass, so the
      // latest fetched_at across them is "the moment this item's prices were
      // synced" (steam, CSFloat, ... together).
      let pricesSyncedAt: string | null = null
      for (const row of byItem.get(i.market_hash_name)?.values() ?? []) {
        if (!pricesSyncedAt || row.fetched_at > pricesSyncedAt) pricesSyncedAt = row.fetched_at
      }
      return {
        assetid: i.assetid,
        contextid: i.contextid ?? '2',
        name: i.name ?? i.market_hash_name,
        market_hash_name: i.market_hash_name,
        icon_url: i.icon_url ?? '',
        marketable: i.marketable === 1,
        marketable_restriction: typeof raw.marketable_restriction === 'number' ? String(raw.marketable_restriction) : raw.marketable_restriction,
        rarity: parseRarity(raw),
        own:
          i.own_float != null
            ? { float_value: i.own_float, paint_seed: i.own_seed ?? 0, stickers: enrichOwnStickers(i.own_stickers, byItem) }
            : null,
        prices: Object.fromEntries(byItem.get(i.market_hash_name) ?? []),
        listing: listing ? { listingid: listing.listingid, price_cents: listing.price_cents } : null,
        pricesSyncedAt,
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