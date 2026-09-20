import { describe, expect, it, vi } from 'vitest'
import type { PriceSnapshotRow } from '../src/server/db'

const dbMock = vi.hoisted(() => ({
  insertPriceSnapshot: vi.fn(),
  latestPriceSnapshots: vi.fn(() => ({ byItem: new Map(), latestAt: null })),
  listItems: vi.fn(() => []),
  listMyListings: vi.fn(() => []),
  replaceMyListings: vi.fn(),
  clearSession: vi.fn(),
  loadSession: vi.fn(() => undefined),
  saveSession: vi.fn(),
  upsertItems: vi.fn(),
}))

vi.mock('../src/server/db', () => dbMock)

import { attachedItemHashes, enrichOwnStickers } from '../src/server/sync'

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