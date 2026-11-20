// Selling and re-listing. Every step that changes the market goes through
// here, so a plain sell and the sell half of a relist track pending
// confirmations the same way.

import { getItem, listMyListings } from './db'
import { clearPendingSell, forgetListing, markPendingSell, refreshListings } from './listings'
import * as steam from './steam'

// Pause between the cancel and the new sell, to pace market writes.
const RELIST_GAP_MS = Number(process.env.SKINHQ_RELIST_GAP_MS ?? 1500)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Puts one asset up for sale and remembers the sell as pending until Steam
 * Mobile approves (or rejects) it. Throws only when there is no usable session.
 */
export async function sellAndTrack(assetid: string, contextid: string | undefined, price: number): Promise<steam.SellResult> {
  // A retried sell supersedes any earlier attempt for the same asset, so drop
  // the stale pending row before asking Steam again.
  clearPendingSell(assetid)
  const result = await steam.sellItem(assetid, price, contextid && contextid !== '2' ? contextid : undefined)
  if (!result.success) return result
  // Steam accepted the sell but will not list it until you approve it in the
  // Steam Mobile app. Remember that so the grid can say "awaiting approval"
  // instead of offering to sell an item that is already committed, and start
  // watching for it to become a listing (or be rejected).
  markPendingSell({ assetid, market_hash_name: getItem(assetid)?.market_hash_name ?? null, price_cents: price })
  if (!result.needs_mobile_confirmation) {
    // Steam listed it outright, so the listing should already exist — confirm
    // immediately instead of waiting out the backoff.
    // refreshListings never rejects: failures come back as { ok: false }.
    void refreshListings()
  }
  return result
}

export type RelistResult =
  | ({ step: 'sell' } & steam.SellResult)
  | { step: 'cancel'; success: false; message: string }

/**
 * Moves a listed asset to a new price: cancel the listing, then sell at
 * `price`. Steam has no single "relist" call. The sell only starts once the
 * cancel went through; if the sell then fails, the item is left unlisted and
 * the result says so.
 */
export async function relist(listingid: string, assetid: string, price: number): Promise<RelistResult> {
  if (!listMyListings().some((l) => l.listingid === listingid && l.assetid === assetid)) {
    return { step: 'cancel', success: false, message: 'that listing is not this item (or is already gone): sync and try again' }
  }
  const cancelled = await steam.cancelListing(listingid)
  if (!cancelled.success) return { step: 'cancel', success: false, message: 'Steam refused to cancel the listing; nothing changed' }
  forgetListing(listingid)
  // The asset comes back under the same id, but possibly in another context;
  // the sell has to name the right one.
  try {
    await steam.refreshInventoryContexts()
  } catch (err) {
    console.warn('[relist] context refresh failed, selling from the stored context:', (err as Error).message)
  }
  await sleep(RELIST_GAP_MS)
  let sold: steam.SellResult
  try {
    sold = await sellAndTrack(assetid, getItem(assetid)?.contextid, price)
  } catch (err) {
    sold = { success: false, needs_mobile_confirmation: false, is_pending: false, message: (err as Error).message }
  }
  void refreshListings()
  if (!sold.success) {
    return { step: 'sell', ...sold, message: `the old listing is cancelled, but the new one failed: ${sold.message ?? 'Steam refused it'}. The item is not listed now.` }
  }
  return { step: 'sell', ...sold }
}
