import { beforeEach, describe, expect, it, vi } from 'vitest'

process.env.SKINHQ_RELIST_GAP_MS = '0'

const dbMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  listMyListings: vi.fn(),
}))
const listingsMock = vi.hoisted(() => ({
  clearPendingSell: vi.fn(),
  forgetListing: vi.fn(),
  markPendingSell: vi.fn(),
  refreshListings: vi.fn(async () => ({ ok: true })),
}))
const steamMock = vi.hoisted(() => ({
  cancelListing: vi.fn(),
  refreshInventoryContexts: vi.fn(async () => ({ total: 1 })),
  sellItem: vi.fn(),
}))

vi.mock('../src/server/db', () => dbMock)
vi.mock('../src/server/listings', () => listingsMock)
vi.mock('../src/server/steam', () => steamMock)

const { relist, sellAndTrack } = await import('../src/server/selling')

const accepted = { success: true, needs_mobile_confirmation: true, is_pending: true }

beforeEach(() => {
  vi.clearAllMocks()
  dbMock.listMyListings.mockReturnValue([{ listingid: 'L1', assetid: 'A1', market_hash_name: 'AK', price_cents: 1000, updated_at: '' }])
  dbMock.getItem.mockReturnValue({ assetid: 'A1', contextid: '2', market_hash_name: 'AK' })
  steamMock.cancelListing.mockResolvedValue({ success: true })
  steamMock.sellItem.mockResolvedValue(accepted)
})

describe('sellAndTrack', () => {
  it('marks an accepted sell as pending, and leaves a refused one alone', async () => {
    expect(await sellAndTrack('A1', '2', 900)).toEqual(accepted)
    expect(listingsMock.clearPendingSell).toHaveBeenCalledWith('A1')
    expect(listingsMock.markPendingSell).toHaveBeenCalledWith({ assetid: 'A1', market_hash_name: 'AK', price_cents: 900 })

    vi.clearAllMocks()
    steamMock.sellItem.mockResolvedValue({ success: false, needs_mobile_confirmation: false, is_pending: false, message: 'no' })
    expect((await sellAndTrack('A1', '2', 900)).success).toBe(false)
    expect(listingsMock.markPendingSell).not.toHaveBeenCalled()
  })

  it('passes a non-default context on to Steam', async () => {
    await sellAndTrack('A1', '16', 900)
    expect(steamMock.sellItem).toHaveBeenCalledWith('A1', 900, '16')
    await sellAndTrack('A1', '2', 900)
    expect(steamMock.sellItem).toHaveBeenLastCalledWith('A1', 900, undefined)
  })
})

describe('relist', () => {
  it('cancels, re-reads the contexts, then sells from the context the item is in now', async () => {
    dbMock.getItem.mockReturnValue({ assetid: 'A1', contextid: '16', market_hash_name: 'AK' })
    const r = await relist('L1', 'A1', 1100)
    expect(r).toEqual({ step: 'sell', ...accepted })
    expect(steamMock.cancelListing).toHaveBeenCalledWith('L1')
    expect(listingsMock.forgetListing).toHaveBeenCalledWith('L1')
    expect(steamMock.refreshInventoryContexts).toHaveBeenCalled()
    expect(steamMock.sellItem).toHaveBeenCalledWith('A1', 1100, '16')
    // Order matters: the sell only after the cancel.
    expect(steamMock.cancelListing.mock.invocationCallOrder[0]).toBeLessThan(steamMock.sellItem.mock.invocationCallOrder[0])
  })

  it('refuses a listing that is not this asset, without touching Steam', async () => {
    const r = await relist('L1', 'OTHER', 1100)
    expect(r).toMatchObject({ step: 'cancel', success: false })
    expect(steamMock.cancelListing).not.toHaveBeenCalled()
  })

  it('stops when Steam refuses the cancel, so nothing is sold', async () => {
    steamMock.cancelListing.mockResolvedValue({ success: false })
    expect(await relist('L1', 'A1', 1100)).toMatchObject({ step: 'cancel', success: false })
    expect(steamMock.sellItem).not.toHaveBeenCalled()
    expect(listingsMock.forgetListing).not.toHaveBeenCalled()
  })

  it('says the item is now unlisted when the new sell fails or throws', async () => {
    steamMock.sellItem.mockResolvedValue({ success: false, needs_mobile_confirmation: false, is_pending: false, message: 'price too low' })
    const refused = await relist('L1', 'A1', 1100)
    expect(refused).toMatchObject({ step: 'sell', success: false })
    expect('message' in refused && refused.message).toMatch(/cancelled.*price too low.*not listed now/)

    steamMock.sellItem.mockRejectedValue(new Error('session expired'))
    const thrown = await relist('L1', 'A1', 1100)
    expect('message' in thrown && thrown.message).toMatch(/cancelled.*session expired.*not listed now/)
  })

  it('still sells when the context refresh fails, from the stored context', async () => {
    steamMock.refreshInventoryContexts.mockRejectedValue(new Error('429'))
    expect((await relist('L1', 'A1', 1100)).success).toBe(true)
    expect(steamMock.sellItem).toHaveBeenCalledWith('A1', 1100, undefined)
  })
})
