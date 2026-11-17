import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListingsRefresh } from '../src/server/listings'

// syncAll end to end, with Steam, SQLite and the listings refresh stubbed out:
// what happens to `last.listings` when a refresh fails (issue #41).
const steamMock = vi.hoisted(() => ({
  authStatus: vi.fn(() => ({ loggedIn: true })),
  probeSessionNow: vi.fn(async () => 'valid'),
  getInventory: vi.fn(async () => ({ items: [], total: 0 })),
}))
const listingsMock = vi.hoisted(() => ({
  refreshListings: vi.fn<() => Promise<ListingsRefresh>>(),
  pendingByAssetId: vi.fn(() => new Map()),
}))

vi.mock('../src/server/steam', () => steamMock)
vi.mock('../src/server/listings', () => listingsMock)
vi.mock('../src/server/price', () => ({ providers: [] }))
vi.mock('../src/server/db', () => ({
  insertPriceSnapshot: vi.fn(),
  latestPriceSnapshots: vi.fn(() => ({ byItem: new Map(), latestAt: null })),
  listItems: vi.fn(() => []),
  listMyListings: vi.fn(() => []),
}))

const { sync } = await import('../src/server/sync')

const failure = (over: Partial<Extract<ListingsRefresh, { ok: false }>> = {}): ListingsRefresh => ({
  ok: false,
  keptPrevious: true,
  error: 'Steam returned no listings but we previously had some — kept previous data',
  suspectSession: false,
  ...over,
})

async function syncWith(result: ListingsRefresh) {
  listingsMock.refreshListings.mockResolvedValueOnce(result)
  expect(await sync.syncAll()).toBe(true)
  return sync.status()
}

describe('sync: last listings timestamp', () => {
  beforeEach(() => steamMock.probeSessionNow.mockClear())

  it('keeps the last good timestamp when a failed refresh kept the previous listings', async () => {
    const good = (await syncWith({ ok: true, total: 3, confirmed: [] })).last.listings
    expect(good).not.toBeNull()

    const after = await syncWith(failure())
    expect(after.last.listings).toBe(good)
    expect(after.errors).toContain(`listings: ${failure().error}`)
    // Steam's empty answer is not a session problem.
    expect(steamMock.probeSessionNow).toHaveBeenCalledTimes(2) // one pre-sync probe per run only
  })

  it('re-checks the session when the request itself failed, still keeping the timestamp', async () => {
    const good = (await syncWith({ ok: true, total: 1, confirmed: [] })).last.listings
    steamMock.probeSessionNow.mockClear()

    const after = await syncWith(failure({ error: 'HTTP error 400', suspectSession: true }))
    expect(after.last.listings).toBe(good)
    expect(steamMock.probeSessionNow).toHaveBeenCalledTimes(2) // pre-sync probe + re-check
  })

  it('clears the timestamp only when the cached listings were lost', async () => {
    await syncWith({ ok: true, total: 1, confirmed: [] })
    expect((await syncWith(failure({ keptPrevious: false }))).last.listings).toBeNull()
  })
})
