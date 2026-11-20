import { describe, expect, it } from 'vitest'
import { unlockDate } from '../src/server/locks'
import { formatUnlock } from '../src/client/format'

describe('unlockDate', () => {
  it('reads the [date] token from the owner text of a locked item', () => {
    const item = { marketable: 0, owner_descriptions: [{ value: '' }, { value: 'Tradable/Marketable After [date]1795737600[/date]' }] }
    expect(unlockDate(item)).toBe('2026-11-27T00:00:00.000Z')
  })

  it("falls back to the date steamcommunity parsed from Steam's text", () => {
    expect(unlockDate({ marketable: false, cache_expiration: '2026-11-27T08:00:00.000Z' })).toBe('2026-11-27T08:00:00.000Z')
    expect(unlockDate({ marketable: false, cache_expiration: 'not a date' })).toBeNull()
  })

  it('is null for a sellable item, and for one that can never be sold', () => {
    expect(unlockDate({ marketable: 1, cache_expiration: '2026-11-27T08:00:00.000Z' })).toBeNull()
    expect(unlockDate({ marketable: 0, owner_descriptions: [{ value: 'Not Marketable' }] })).toBeNull()
  })
})

describe('formatUnlock', () => {
  const now = Date.parse('2026-11-20T12:00:00Z')
  it('counts down in days, hours or minutes', () => {
    expect(formatUnlock('2026-11-27T12:00:00Z', now)).toBe('in 7 days')
    expect(formatUnlock('2026-11-21T17:00:00Z', now)).toBe('in 29 h')
    expect(formatUnlock('2026-11-20T12:12:00Z', now)).toBe('in 12 min')
    expect(formatUnlock('2026-11-20T11:00:00Z', now)).toBe('any moment now')
  })
})
