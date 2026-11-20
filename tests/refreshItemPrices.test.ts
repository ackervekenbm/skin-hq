import { describe, expect, it, vi } from 'vitest'

const dbMock = vi.hoisted(() => ({
  insertPriceSnapshot: vi.fn(),
  prunePriceSnapshots: vi.fn(() => 0),
  latestPriceSnapshots: vi.fn(() => ({ byItem: new Map(), latestAt: null })),
  listItems: vi.fn(() => []),
  listMyListings: vi.fn(() => []),
  deleteMyListing: vi.fn(),
  replaceMyListings: vi.fn(),
  clearSession: vi.fn(),
  loadSession: vi.fn(() => undefined),
  saveSession: vi.fn(),
  upsertItems: vi.fn(),
}))
const priceMock = vi.hoisted(() => ({
  providers: [
    { name: 'steam', getItem: vi.fn() },
    { name: 'csfloat', getItem: vi.fn() },
  ],
}))

vi.mock('../src/server/db', () => dbMock)
vi.mock('../src/server/listings', () => ({ pendingByAssetId: vi.fn(() => new Map()), refreshListings: vi.fn() }))
vi.mock('../src/server/price', () => priceMock)

const { refreshItemPrices } = await import('../src/server/sync')

describe('refreshItemPrices', () => {
  it('stores a snapshot per provider, errors included, and reports the errors', async () => {
    const [steam, csfloat] = priceMock.providers
    steam.getItem.mockResolvedValue({ provider: 'steam', currency: 'EUR', lowest_cents: 1250, volume: 4 })
    csfloat.getItem.mockRejectedValue(new Error('HTTP 401'))

    const errors = await refreshItemPrices('AK-47 | Vulcan (Field-Tested)')

    expect(errors).toEqual(['csfloat: HTTP 401'])
    expect(dbMock.insertPriceSnapshot).toHaveBeenCalledTimes(2)
    expect(dbMock.insertPriceSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ market_hash_name: 'AK-47 | Vulcan (Field-Tested)', provider: 'steam', lowest_cents: 1250, volume: 4, had_error: 0 }),
    )
    expect(dbMock.insertPriceSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'csfloat', lowest_cents: null, had_error: 1, note: 'HTTP 401' }),
    )
  })
})
