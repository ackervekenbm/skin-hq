import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it, vi } from 'vitest'

// db.ts resolves DATA_DIR (and mkdirs it) at module load, so the throwaway
// directory has to exist in the environment before the import runs. vi.hoisted
// runs ahead of module imports but also ahead of our own `node:fs` import, so
// build the path from plain globals and let db.ts create the directory.
const dir = vi.hoisted(
  () => `${process.env.TMPDIR?.replace(/\/$/, '') ?? '/tmp'}/skinhq-db-${process.pid}-${Math.random().toString(36).slice(2)}`,
)
process.env.DATA_DIR = dir
process.env.SKINHQ_SESSION_KEY = 'test-key-for-db-tests'

const db = await import('../src/server/db')

const item = (over: Partial<Parameters<typeof db.upsertItems>[0][number]> = {}): Parameters<typeof db.upsertItems>[0][number] => ({
  assetid: 'A1',
  appid: 730,
  contextid: '2',
  market_hash_name: 'AK-47 | Vulcan',
  name: 'AK-47 | Vulcan',
  type: 'Rifle',
  icon_url: 'https://cdn.example/icon.jpg',
  tradable: 1,
  marketable: 1,
  raw: '{}',
  own_float: null,
  own_seed: null,
  own_stickers: null,
  updated_at: '2026-09-25T00:00:00Z',
  ...over,
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('upsertItems', () => {
  it('persists the fields it inserts', () => {
    db.upsertItems([item({ own_float: 0.0312, own_seed: 812 })])
    const row = db.getItem('A1')
    expect(row?.own_float).toBe(0.0312)
    expect(row?.own_seed).toBe(812)
    expect(row?.contextid).toBe('2')
  })

  // Regression: contextid was in the INSERT column list but missing from the
  // DO UPDATE SET, so an asset's context change was silently dropped. Listing an
  // item moves it 2 -> 16 and cancelling moves it back, which left the grid
  // reading a stale context and made cancelled items disappear.
  it('updates contextid and marketable when an asset changes hands with Steam', () => {
    db.upsertItems([item()])
    db.upsertItems([item({ contextid: '16', marketable: 0 })])

    const row = db.getItem('A1')
    expect(row?.contextid).toBe('16')
    expect(row?.marketable).toBe(0)
  })

  it('moves the context back on cancel', () => {
    db.upsertItems([item({ contextid: '16', marketable: 0 })])
    db.upsertItems([item({ contextid: '2', marketable: 1 })])

    expect(db.getItem('A1')?.contextid).toBe('2')
    expect(db.getItem('A1')?.marketable).toBe(1)
  })

  // Regression: own_float/own_seed/own_stickers come from a best-effort
  // asset_properties pass, so a sync that could not read them arrives with nulls.
  // An unconditional overwrite wiped the stored floats for the whole inventory.
  it('keeps stored floats when a later pass has none for that asset', () => {
    db.upsertItems([item({ own_float: 0.0312, own_seed: 812, own_stickers: '{"stickers":[]}' })])
    db.upsertItems([item({ own_float: null, own_seed: null, own_stickers: null, contextid: '16', marketable: 0 })])

    const row = db.getItem('A1')
    expect(row?.own_float).toBe(0.0312)
    expect(row?.own_seed).toBe(812)
    expect(row?.own_stickers).toBe('{"stickers":[]}')
  })

  it('still overwrites a float when a later pass reports a different one', () => {
    db.upsertItems([item({ own_float: 0.5 })])
    db.upsertItems([item({ own_float: 0.0312 })])

    expect(db.getItem('A1')?.own_float).toBe(0.0312)
  })

  it('treats a real float of zero as a value, not as missing', () => {
    db.upsertItems([item({ own_float: 0.1234 })])
    db.upsertItems([item({ own_float: 0 })])

    expect(db.getItem('A1')?.own_float).toBe(0)
  })
})

describe('pending_listings', () => {
  const row = (over: Partial<Parameters<typeof db.upsertPendingListing>[0]> = {}): Parameters<typeof db.upsertPendingListing>[0] => ({
    assetid: 'P1',
    market_hash_name: 'AK-47 | Vulcan',
    price_cents: 1250,
    ...over,
  })

  it('records a new sell as awaiting', () => {
    db.upsertPendingListing(row({ assetid: 'P0' }))
    const found = db.listPendingListings().filter((p) => p.assetid === 'P0')
    expect(found.map((p) => [p.assetid, p.state, p.price_cents])).toEqual([['P0', 'awaiting', 1250]])
  })

  it('lets a retry supersede the previous attempt', () => {
    db.upsertPendingListing(row({ price_cents: 1250 }))
    db.upsertPendingListing(row({ price_cents: 900 }))

    const pending = db.listPendingListings().filter((p) => p.assetid === 'P1')
    expect(pending).toHaveLength(1)
    expect(pending[0].price_cents).toBe(900)
  })

  it('resets a declined row to awaiting when the item is listed again', () => {
    db.upsertPendingListing(row())
    db.setPendingListingState(['P1'], 'declined')
    expect(db.listPendingListings().find((p) => p.assetid === 'P1')?.state).toBe('declined')

    db.upsertPendingListing(row({ price_cents: 950 }))
    expect(db.listPendingListings().find((p) => p.assetid === 'P1')?.state).toBe('awaiting')
  })

  it('only flips the rows it was given', () => {
    db.upsertPendingListing(row({ assetid: 'P1' }))
    db.upsertPendingListing(row({ assetid: 'P2' }))
    db.setPendingListingState(['P1'], 'declined')

    const state = new Map(db.listPendingListings().map((p) => [p.assetid, p.state]))
    expect(state.get('P1')).toBe('declined')
    expect(state.get('P2')).toBe('awaiting')
  })

  it('clears a confirmed sell and ignores a no-op delete', () => {
    db.upsertPendingListing(row({ assetid: 'P9' }))
    db.deletePendingListings(['P9'])
    expect(db.listPendingListings().find((p) => p.assetid === 'P9')).toBeUndefined()

    expect(() => db.deletePendingListings([])).not.toThrow()
  })
})

describe('my_listings', () => {
  const at = '2026-09-25T00:00:00Z'
  const listing = (over = {}): Parameters<typeof db.replaceMyListings>[0][number] => ({
    listingid: 'L1',
    assetid: 'A1',
    market_hash_name: 'AK-47 | Vulcan',
    price_cents: 1250,
    updated_at: at,
    ...over,
  })

  it('replaces the cached set wholesale', () => {
    db.replaceMyListings([listing(), listing({ listingid: 'L2', assetid: 'A2' })])
    expect(db.listMyListings().map((l) => l.listingid).sort()).toEqual(['L1', 'L2'])

    db.replaceMyListings([listing({ listingid: 'L3' })])
    expect(db.listMyListings().map((l) => l.listingid)).toEqual(['L3'])
  })

  it('accepts a listing with no assetid, so it can still be shown by hash', () => {
    db.replaceMyListings([listing({ assetid: null })])
    expect(db.listMyListings()[0].assetid).toBeNull()
  })

  // Cancelling one of several identical items must not take its siblings with it.
  it('removes only the cancelled listing', () => {
    db.replaceMyListings([
      listing({ listingid: 'L1', assetid: 'A1', price_cents: 100 }),
      listing({ listingid: 'L2', assetid: 'A2', price_cents: 200 }),
    ])
    db.deleteMyListing('L1')

    const left = db.listMyListings()
    expect(left.map((l) => l.listingid)).toEqual(['L2'])
    expect(left[0].price_cents).toBe(200)
  })

  it('tolerates deleting an unknown listing', () => {
    expect(() => db.deleteMyListing('nope')).not.toThrow()
  })
})