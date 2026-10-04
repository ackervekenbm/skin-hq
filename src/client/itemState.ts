// The one place that decides what an item's market status is, so the card, the
// detail modal and the sell guard can never disagree with each other.
//
// Selling on Steam is a two-step handshake: `sellitem` is accepted, then you
// approve it in the Steam Mobile app, and only then is there a listing. The
// states in between used to be invisible, which is why a freshly listed item
// kept offering itself for sale.

export interface PendingView {
  state: 'awaiting' | 'declined'
  price_cents: number | null
  created_at: string
}

export interface ListingStateInput {
  listing: { listingid: string; price_cents: number | null } | null
  pending: PendingView | null
  marketable: boolean
}

export type ItemState = 'awaiting' | 'listed' | 'rejected' | 'marketable' | 'restricted'

export const ITEM_STATE_LABEL: Record<ItemState, string> = {
  awaiting: 'awaiting approval',
  listed: 'listed',
  rejected: 'rejected',
  marketable: 'sellable',
  restricted: 'restricted',
}

export function itemState(item: ListingStateInput): ItemState {
  // Steam is holding a sell that has not become a listing yet. Nothing else can
  // be true about this item: it is not on the market, and it is not sellable.
  if (item.pending?.state === 'awaiting') return 'awaiting'
  if (item.listing) return 'listed'
  // The mobile confirmation was rejected or expired. Steam is offering the item
  // again, so it is sellable — but say why, or the rejection looks like a no-op.
  if (item.pending?.state === 'declined') return 'rejected'
  return item.marketable ? 'marketable' : 'restricted'
}

/** Whether the sell box may be used for this item right now. */
export function canSell(item: ListingStateInput): boolean {
  const state = itemState(item)
  // A rejected sell left the item untouched, so the retry is just another sell.
  return state === 'marketable' || state === 'rejected'
}

/** Whether the cancel affordance applies — only a real listing can be cancelled. */
export function canCancel(item: ListingStateInput): boolean {
  return itemState(item) === 'listed'
}