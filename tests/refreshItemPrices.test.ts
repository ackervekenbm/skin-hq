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

const { refreshItemPrices, refreshRefusal, sync } = await import('../src/server/sync')

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

describe('refreshRefusal', () => {
  it('lets one refresh per item through every 30 s', async () => {
    const t = Date.now()
    expect(refreshRefusal('Fresh item', t)).toBeNull()
    await refreshItemPrices('Fresh item')
    expect(refreshRefusal('Fresh item', t + 1_000)).toMatch(/try again in (29|30) s/)
    expect(refreshRefusal('Another item', t + 1_000)).toBeNull()
    expect(refreshRefusal('Fresh item', t + 31_000)).toBeNull()
  })

  it('refuses while a sync is running', () => {
    const spy = vi.spyOn(sync, 'status').mockReturnValue({ ...sync.status(), running: true })
    try {
      expect(refreshRefusal('Idle item')).toMatch(/sync is running/)
    } finally {
      spy.mockRestore()
    }
  })
})
