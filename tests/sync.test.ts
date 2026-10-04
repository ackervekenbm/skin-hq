import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ItemRow, MyListingRow, PendingListingRow, PriceSnapshotRow } from '../src/server/db'

const dbMock = vi.hoisted(() => ({
  insertPriceSnapshot: vi.fn(),
  latestPriceSnapshots: vi.fn(() => ({ byItem: new Map(), latestAt: null })),
  listItems: vi.fn(() => [] as ItemRow[]),
  listMyListings: vi.fn(() => [] as MyListingRow[]),
  deleteMyListing: vi.fn(),
  replaceMyListings: vi.fn(),
  clearSession: vi.fn(),
  loadSession: vi.fn(() => undefined),
  saveSession: vi.fn(),
  upsertItems: vi.fn(),
}))

// sync.ts reaches listing state through listings.ts (single-flight refresh +
// pending rows); stub it so buildGrid can be exercised without Steam or SQLite.
const listingsMock = vi.hoisted(() => ({
  pendingByAssetId: vi.fn(() => new Map<string, PendingListingRow>()),
  refreshListings: vi.fn(async () => ({ ok: true as const, total: 0, confirmed: [] })),
}))

vi.mock('../src/server/db', () => dbMock)
vi.mock('../src/server/listings', () => listingsMock)

import { attachedItemHashes, buildGrid, enrichOwnStickers, makeListingLookup } from '../src/server/sync'

function steamSnapshot(overrides: Partial<PriceSnapshotRow> = {}): PriceSnapshotRow {
  return {
    id: 0,
    market_hash_name: 'x',
    provider: 'steam',
    lowest_cents: null,
    median_cents: null,
    volume: null,
    sell_count: null,
    buy_count: null,
    highest_buy_cents: null,
    float_value: null,
    paint_seed: null,
    stickers: null,
    had_error: 0,
    note: null,
    fetched_at: '2026-09-20T00:00:00Z',
    ...overrides,
  }
}

describe('attachedItemHashes', () => {
  it('collects mounted-charm market hashes, deduped across weapons', () => {
    const rows = [
      JSON.stringify({ stickers: [], keychains: [{ name: 'Gritty' }] }),
      JSON.stringify({ stickers: [], keychains: [{ name: 'Gritty' }] }),
      JSON.stringify({ stickers: [], keychains: [{ name: "Lil' No. 2" }] }),
    ]
    expect(attachedItemHashes(rows)).toEqual(["Charm | Gritty", "Charm | Lil' No. 2"])
  })

  it('skips null/malformed rows and charms without a name', () => {
    expect(attachedItemHashes([null, 'not json', JSON.stringify({ keychains: [{}] })])).toEqual([])
  })
})

describe('enrichOwnStickers', () => {
  it('decorates the charm keychain with venue worth, buy depth and volume', () => {
    const raw = JSON.stringify({ stickers: [], keychains: [{ stickerId: 7, slot: 5, pattern: 42, name: 'Gritty' }] })
    const steam = new Map<string, PriceSnapshotRow>()
    steam.set(
      'steam',
      steamSnapshot({
        lowest_cents: 32,
        median_cents: 30,
        highest_buy_cents: 28,
        buy_count: 9,
        volume: 41,
      }),
    )
    steam.set('csfloat', steamSnapshot({ provider: 'csfloat', lowest_cents: 26 }))
    const byItem = new Map<string, Map<string, PriceSnapshotRow>>([['Charm | Gritty', steam]])

    const out = JSON.parse(enrichOwnStickers(raw, byItem) ?? 'null') as {
      keychains: Array<Record<string, unknown>>
    }
    expect(out.keychains[0]).toMatchObject({
      name: 'Gritty',
      steam_cents: 32,
      steam_median_cents: 30,
      steam_buy_cents: 28,
      steam_buy_count: 9,
      steam_volume: 41,
      csfloat_cents: 26,
    })
  })

  it('leaves a charm with no snapshot untouched', () => {
    const raw = JSON.stringify({ stickers: [], keychains: [{ name: 'Nobody' }] })
    const out = JSON.parse(enrichOwnStickers(raw, new Map()) ?? 'null') as { keychains: Array<Record<string, unknown>> }
    expect(out.keychains[0]).toEqual({ name: 'Nobody' })
  })

  it('returns null for null input and the raw string for malformed JSON', () => {
    expect(enrichOwnStickers(null, new Map())).toBeNull()
    expect(enrichOwnStickers('not json {', new Map())).toBe('not json {')
  })
})

// ── Listing join ───────────────────────────────────────────────────────────
//
// The grid used to match owned items to listings on market_hash_name alone,
// which is wrong on any inventory with duplicates: listing one of six identical
// "Charm | Lil' SAS" marked all six as listed and left no way to cancel just
// one. assetid is the exact key; hash is only a fallback for rows whose assetid
// went stale.

describe('makeListingLookup', () => {
  it('matches by assetid, so duplicate items are told apart', () => {
    const find = makeListingLookup(
      [
        { listingid: 'L1', assetid: 'A1', market_hash_name: "Charm | Lil' SAS", price_cents: 500 },
        { listingid: 'L2', assetid: 'A2', market_hash_name: "Charm | Lil' SAS", price_cents: 700 },
      ],
      // We own several of these, so the name cannot identify one.
      new Map([["Charm | Lil' SAS", 6]]),
    )
    expect(find('A1', "Charm | Lil' SAS")?.listingid).toBe('L1')
    expect(find('A2', "Charm | Lil' SAS")?.listingid).toBe('L2')
    // A third, unlisted copy must not inherit a neighbour's listing.
    expect(find('A3', "Charm | Lil' SAS")).toBeNull()
  })

  it('falls back to the hash when we own a single copy and the row has no assetid', () => {
    const find = makeListingLookup([{ listingid: 'L1', assetid: '', market_hash_name: 'USP-S | Ticket to Hell', price_cents: 300 }])
    expect(find('ONLY', 'USP-S | Ticket to Hell')?.listingid).toBe('L1')
  })

  it('refuses to guess between duplicates: an orphan row is dropped, not misattributed', () => {
    const find = makeListingLookup(
      [{ listingid: 'orphan', assetid: '', market_hash_name: "Charm | Lil' SAS", price_cents: 100 }],
      // We own six of them, so the name says nothing about which one this is.
      new Map([["Charm | Lil' SAS", 6]]),
    )
    expect(find("ANY", "Charm | Lil' SAS")).toBeNull()
  })

  it('still matches a duplicate by assetid even though the hash is ambiguous', () => {
    const find = makeListingLookup(
      [{ listingid: 'mine', assetid: 'A9', market_hash_name: "Charm | Lil' SAS", price_cents: 900 }],
      new Map([["Charm | Lil' SAS", 6]]),
    )
    expect(find('A9', "Charm | Lil' SAS")?.listingid).toBe('mine')
    expect(find('A8', "Charm | Lil' SAS")).toBeNull()
  })

  it('never lets the hash fallback override an assetid match', () => {
    const find = makeListingLookup([
      { listingid: 'orphan', assetid: '', market_hash_name: 'Charm | Lil SAS', price_cents: 100 },
      { listingid: 'mine', assetid: 'A9', market_hash_name: 'Charm | Lil SAS', price_cents: 900 },
    ])
    expect(find('A9', 'Charm | Lil SAS')?.listingid).toBe('mine')
  })

  it('prefers the cheapest listing for a hash fallback', () => {
    const find = makeListingLookup([
      { listingid: 'expensive', assetid: '', market_hash_name: 'X', price_cents: 900 },
      { listingid: 'cheap', assetid: '', market_hash_name: 'X', price_cents: 100 },
    ])
    expect(find('ONLY', 'X')?.listingid).toBe('cheap')
  })

  it('returns null for an item with no listing, and for unusable rows', () => {
    const find = makeListingLookup([{ listingid: 'L1', assetid: 'A1', market_hash_name: 'Y', price_cents: 1 }])
    expect(find('A2', 'Z')).toBeNull()
    expect(makeListingLookup([{ listingid: 'L1', assetid: '', market_hash_name: '', price_cents: null }])('A1', 'Y')).toBeNull()
  })

  it('does not mutate the caller\'s rows while picking the cheapest', () => {
    const rows = [
      { listingid: 'expensive', assetid: '', market_hash_name: 'X', price_cents: 900 },
      { listingid: 'cheap', assetid: '', market_hash_name: 'X', price_cents: 100 },
    ]
    makeListingLookup(rows)
    expect(rows.map((r) => r.listingid)).toEqual(['expensive', 'cheap'])
  })
})

// ── Pending sells ──────────────────────────────────────────────────────────
//
// Steam accepts a sell and then holds it until the sell is approved in the
// Steam Mobile app. Nothing exists on the market in between, so without an
// explicit record of that window the item kept looking sellable.

function itemRow(over: Partial<ItemRow> = {}): ItemRow {
  return {
    assetid: 'A1',
    appid: 730,
    contextid: '2',
    market_hash_name: 'AK-47 | Vulcan',
    name: 'AK-47 | Vulcan',
    type: 'Rifle',
    icon_url: 'icon',
    tradable: 1,
    marketable: 1,
    raw: '{}',
    own_float: null,
    own_seed: null,
    own_stickers: null,
    updated_at: '2026-09-25T00:00:00Z',
    ...over,
  }
}

function pendingRow(over: Partial<PendingListingRow> = {}): PendingListingRow {
  return {
    assetid: 'A1',
    market_hash_name: 'AK-47 | Vulcan',
    price_cents: 1250,
    state: 'awaiting',
    created_at: '2026-09-25T00:00:00Z',
    updated_at: '2026-09-25T00:00:00Z',
    ...over,
  }
}

describe('buildGrid pending sells', () => {
  beforeEach(() => {
    dbMock.listItems.mockReturnValue([])
    dbMock.listMyListings.mockReturnValue([])
    listingsMock.pendingByAssetId.mockReturnValue(new Map())
  })

  it('surfaces a pending sell so the item stops offering itself for sale', () => {
    // Steam flips marketable off while it holds the sell, so the pending row is
    // the only thing keeping the item in the grid at all.
    dbMock.listItems.mockReturnValue([itemRow({ marketable: 0, contextid: '16' })])
    listingsMock.pendingByAssetId.mockReturnValue(new Map([['A1', pendingRow()]]))

    const grid = buildGrid()
    expect(grid.items).toHaveLength(1)
    expect(grid.items[0].pending).toEqual({ state: 'awaiting', price_cents: 1250, created_at: '2026-09-25T00:00:00Z' })
    expect(grid.items[0].listing).toBeNull()
    expect(grid.counts.pending).toBe(1)
  })

  it('keeps a rejected sell visible and counted', () => {
    dbMock.listItems.mockReturnValue([itemRow()])
    listingsMock.pendingByAssetId.mockReturnValue(new Map([['A1', pendingRow({ state: 'declined' })]]))

    const grid = buildGrid()
    expect(grid.items[0].pending?.state).toBe('declined')
    expect(grid.counts.pending).toBe(1)
  })

  it('clears the pending row once the listing exists, since the listing is the stronger fact', () => {
    dbMock.listItems.mockReturnValue([itemRow({ marketable: 0, contextid: '16' })])
    dbMock.listMyListings.mockReturnValue([
      { listingid: 'L1', assetid: 'A1', market_hash_name: 'AK-47 | Vulcan', price_cents: 1250, updated_at: '2026-09-25T00:00:00Z' },
    ])
    listingsMock.pendingByAssetId.mockReturnValue(new Map([['A1', pendingRow()]]))

    const grid = buildGrid()
    expect(grid.items[0].listing).toEqual({ listingid: 'L1', price_cents: 1250 })
    expect(grid.items[0].pending).toBeNull()
    expect(grid.counts.pending).toBe(0)
  })

  it('keeps a listed item in the grid even though Steam reports it unmarketable', () => {
    dbMock.listItems.mockReturnValue([itemRow({ marketable: 0, contextid: '16' })])
    dbMock.listMyListings.mockReturnValue([
      { listingid: 'L1', assetid: 'A1', market_hash_name: 'AK-47 | Vulcan', price_cents: 1250, updated_at: '2026-09-25T00:00:00Z' },
    ])

    const grid = buildGrid()
    expect(grid.items).toHaveLength(1)
    expect(grid.counts.marketable).toBe(1)
    expect(grid.counts.listed).toBe(1)
  })

  it('drops an item Steam will not sell and has no listing for', () => {
    dbMock.listItems.mockReturnValue([itemRow({ assetid: 'A2', marketable: 0 })])
    expect(buildGrid().items).toHaveLength(0)
  })

  it('does not let one duplicate item mark its twins as listed', () => {
    // Three copies of the same market item, only one of them listed.
    const dupes = ['A1', 'A2', 'A3'].map((assetid) => itemRow({ assetid, marketable: 0, contextid: '16' }))
    dbMock.listItems.mockReturnValue(dupes)
    dbMock.listMyListings.mockReturnValue([
      { listingid: 'L1', assetid: 'A2', market_hash_name: 'AK-47 | Vulcan', price_cents: 1250, updated_at: '2026-09-25T00:00:00Z' },
    ])

    const grid = buildGrid()
    const byAsset = new Map(grid.items.map((i) => [i.assetid, i]))
    expect(grid.counts.listed).toBe(1)
    expect(byAsset.get('A2')?.listing).toEqual({ listingid: 'L1', price_cents: 1250 })
    // The twins are unmarketable in context 16 with no listing of their own, so
    // they leave the grid instead of inheriting the listed copy's state.
    expect(byAsset.has('A1')).toBe(false)
    expect(byAsset.has('A3')).toBe(false)
  })

  it('keeps sellable duplicates in the grid, and only marks the listed one', () => {
    const dupes = ['A1', 'A2', 'A3'].map((assetid) => itemRow({ assetid }))
    dbMock.listItems.mockReturnValue(dupes)
    dbMock.listMyListings.mockReturnValue([
      { listingid: 'L1', assetid: 'A2', market_hash_name: 'AK-47 | Vulcan', price_cents: 1250, updated_at: '2026-09-25T00:00:00Z' },
    ])

    const grid = buildGrid()
    const byAsset = new Map(grid.items.map((i) => [i.assetid, i]))
    expect(grid.items).toHaveLength(3)
    expect(byAsset.get('A2')?.listing?.listingid).toBe('L1')
    expect(byAsset.get('A1')?.listing).toBeNull()
    expect(byAsset.get('A3')?.listing).toBeNull()
  })

  it('still matches an orphan listing row by hash when the item is unique', () => {
    dbMock.listItems.mockReturnValue([itemRow({ assetid: 'A1', marketable: 0, contextid: '16' })])
    dbMock.listMyListings.mockReturnValue([
      { listingid: 'L1', assetid: 'GONE', market_hash_name: 'AK-47 | Vulcan', price_cents: 1250, updated_at: '2026-09-25T00:00:00Z' },
    ])

    const grid = buildGrid()
    expect(grid.items[0].listing).toEqual({ listingid: 'L1', price_cents: 1250 })
  })
})