import { describe, expect, it } from 'vitest'
import { canCancel, canSell, itemState, ITEM_STATE_LABEL, type ListingStateInput } from '../src/client/itemState'

function item(over: Partial<ListingStateInput> = {}): ListingStateInput {
  return { listing: null, pending: null, marketable: true, ...over }
}

const awaiting = (): ListingStateInput => item({ pending: { state: 'awaiting', price_cents: 1000, created_at: '2026-01-01T00:00:00Z' } })
const rejected = (): ListingStateInput => item({ pending: { state: 'declined', price_cents: 1000, created_at: '2026-01-01T00:00:00Z' } })
const listed = (): ListingStateInput => item({ listing: { listingid: '1', price_cents: 900 } })

describe('itemState', () => {
  it('reports an accepted-but-unconfirmed sell as awaiting, above every other fact', () => {
    // Steam stops offering the asset while it holds the sell, so the pending row
    // is the only thing that knows what is happening. This is the state that
    // used to not exist, which is why a just-listed item kept offering to sell.
    expect(itemState(awaiting())).toBe('awaiting')
    expect(itemState(item({ pending: { state: 'awaiting', price_cents: 1, created_at: '' }, marketable: false }))).toBe('awaiting')
  })

  it('prefers a real listing over a pending row', () => {
    expect(itemState(item({ listing: { listingid: '1', price_cents: 900 }, pending: { state: 'declined', price_cents: 1, created_at: '' } }))).toBe('listed')
  })

  it('reports a rejected confirmation as rejected while still allowing a retry', () => {
    expect(itemState(rejected())).toBe('rejected')
    expect(canSell(rejected())).toBe(true)
  })

  it('falls back to marketable / restricted', () => {
    expect(itemState(item())).toBe('marketable')
    expect(itemState(item({ marketable: false }))).toBe('restricted')
  })

  it('has a label for every state', () => {
    for (const state of ['awaiting', 'listed', 'rejected', 'marketable', 'restricted'] as const) {
      expect(ITEM_STATE_LABEL[state]).toBeTruthy()
    }
  })
})

describe('canSell', () => {
  it('refuses an item that is awaiting approval or already listed', () => {
    expect(canSell(awaiting())).toBe(false)
    expect(canSell(listed())).toBe(false)
  })

  it('refuses an item Steam will not sell', () => {
    expect(canSell(item({ marketable: false }))).toBe(false)
  })

  it('allows a plain sellable item', () => {
    expect(canSell(item())).toBe(true)
  })
})

describe('canCancel', () => {
  it('only offers cancel for a real listing', () => {
    expect(canCancel(listed())).toBe(true)
    expect(canCancel(item())).toBe(false)
    // A pending sell has no listingid yet, so there is nothing to cancel.
    expect(canCancel(awaiting())).toBe(false)
    expect(canCancel(rejected())).toBe(false)
  })
})