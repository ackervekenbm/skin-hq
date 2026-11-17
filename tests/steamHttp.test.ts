import { beforeEach, describe, expect, it, vi } from 'vitest'

type Callback = (err: Error | null, response: { statusCode: number } | undefined, body: unknown) => void

const http = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }))

vi.mock('../src/server/db', () => ({
  clearSession: vi.fn(),
  loadSession: vi.fn(() => undefined),
  saveSession: vi.fn(),
  upsertItems: vi.fn(),
  getItem: vi.fn(),
}))

vi.mock('steamcommunity', () => ({
  default: class {
    steamID = { getSteamID64: () => '76561198000000000' }
    on(): void {}
    getSessionID(): string {
      return 'sid'
    }
    httpRequestPost(_uri: string, _opts: unknown, cb: Callback): void {
      http.post(cb)
    }
    httpRequestGet(_uri: string, _opts: unknown, cb: Callback): void {
      http.get(cb)
    }
  },
}))

import { cancelListing, sellItem } from '../src/server/steam'

// What steamcommunity does for a non-2xx answer: an "HTTP error <n>" plus the
// parsed body.
const refuse = (status: number, body: unknown) => (cb: Callback) => cb(new Error(`HTTP error ${status}`), { statusCode: status }, body)

beforeEach(() => {
  http.post.mockReset()
})

describe('market POSTs', () => {
  it("shows Steam's reason for a refused sell, without retrying it", async () => {
    http.post.mockImplementation(refuse(502, { success: false, message: 'You have too many listings pending confirmation.' }))
    const res = await sellItem('123', 150)
    expect(res).toMatchObject({ success: false, message: 'You have too many listings pending confirmation.' })
    expect(http.post).toHaveBeenCalledTimes(1)
  })

  it('reports a refused cancel as unsuccessful instead of throwing', async () => {
    http.post.mockImplementation(refuse(500, {}))
    await expect(cancelListing('456')).resolves.toEqual({ success: false })
    expect(http.post).toHaveBeenCalledTimes(1)
  })

  it('still fails when Steam sends no JSON to explain itself', async () => {
    http.post.mockImplementation(refuse(502, undefined))
    await expect(sellItem('123', 150)).rejects.toThrow('HTTP error 502')
    expect(http.post).toHaveBeenCalledTimes(1)
  })

  it('passes a successful sell through', async () => {
    http.post.mockImplementation((cb: Callback) => cb(null, { statusCode: 200 }, { success: true, requires_confirmation: 1, needs_mobile_confirmation: true }))
    await expect(sellItem('123', 150)).resolves.toMatchObject({ success: true, needs_mobile_confirmation: true })
  })
})
