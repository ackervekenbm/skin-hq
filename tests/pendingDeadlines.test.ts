import { describe, expect, it, vi } from 'vitest'

process.env.SKINHQ_DECLINE_GRACE_MS = '90000'
process.env.SKINHQ_PENDING_TTL_MS = '1800000'
vi.mock('../src/server/db', () => ({}))
vi.mock('../src/server/steam', () => ({}))

const { pendingDeadlines } = await import('../src/server/listings')

describe('pendingDeadlines', () => {
  it('puts the first Steam check after the grace window and the give-up after the TTL', () => {
    expect(pendingDeadlines('2026-11-20T10:00:00.000Z')).toEqual({
      checks_at: '2026-11-20T10:01:30.000Z',
      gives_up_at: '2026-11-20T10:30:00.000Z',
    })
  })
})
