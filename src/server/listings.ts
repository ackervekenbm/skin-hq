import {
  deleteMyListing,
  deletePendingListings,
  listMyListings,
  listPendingListings,
  replaceMyListings,
  setPendingListingState,
  upsertPendingListing,
  type MyListingRow,
  type PendingListingRow,
} from './db'
import * as steam from './steam'

// ── Listing state ──────────────────────────────────────────────────────────
//
// A sell on Steam is not one event but two. `sellitem` accepts the request and
// Steam holds it until you approve the sell in the Steam Mobile app; only then
// does the asset appear in `mylistings`. Until that second event happens the
// item is in limbo: not sellable, not listed.
//
// This module owns everything between those two events so the grid never has
// to guess:
//
//   (nothing)  --sell-->  awaiting  --approved-->  listed   (pending row deleted,
//                              |                    normal listing join takes over)
//                              +--rejected/expired--> declined  (item is sellable again)
//
// The pending row is what the UI renders as "awaiting approval". It is dropped
// as soon as the asset shows up in a listing, or once the whole window passes
// without one. Nothing here waits for a full sync — the grid reflects a sell
// within seconds of the mobile approval instead of up to an hour.

// Backoff between reconcile passes. The first passes are tight so the common
// case (approve within a few seconds) resolves almost immediately; later passes
// stretch out so a forgotten approval cannot turn into a request flood.
const RECONCILE_MIN_DELAY_MS = 2_000
const RECONCILE_MAX_DELAY_MS = 20_000
const RECONCILE_BACKOFF = 1.4

// How long a sell may sit unconfirmed before we ask Steam whether the asset is
// still being offered for sale. Steam mobile confirmations land in seconds to
// a couple of minutes; an asset Steam still wants to sell after this window was
// almost certainly never committed to the market.
const DECLINE_GRACE_MS = Number(process.env.SKINHQ_DECLINE_GRACE_MS ?? 90_000)

// Absolute lifetime of a pending sell. Bounds the "awaiting approval" state so
// a confirmation that is neither approved nor rejected stops blocking the item.
const PENDING_TTL_MS = Number(process.env.SKINHQ_PENDING_TTL_MS ?? 30 * 60_000)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export type ListingsRefresh =
  | { ok: true; total: number; confirmed: string[] }
  | {
      ok: false
      keptPrevious: boolean
      error: string
      /** True when the request itself failed, so callers can re-check the session. */
      suspectSession: boolean
    }

let inflight: Promise<ListingsRefresh> | null = null

/**
 * Pull the live listing set from Steam and make it the cached truth.
 *
 * Single-flighted: a scheduled sync, a post-sell reconcile and a post-cancel
 * reconcile all share one in-flight request rather than racing each other onto
 * the same market endpoint. Also resolves any pending sells that just became
 * real listings.
 */
export function refreshListings(): Promise<ListingsRefresh> {
  if (inflight) return inflight
  const run = (async (): Promise<ListingsRefresh> => {
    try {
      const { listings } = await steam.getMyListings()
      const previous = listMyListings().length
      if (listings.length === 0 && previous > 0) {
        // Steam can transiently return "no listings" (HTTP 400 / empty body)
        // while real listings still exist — never let that wipe the table.
        console.warn('[listings] Steam returned no listings while we had rows; keeping previous data')
        return {
          ok: false,
          keptPrevious: true,
          error: 'Steam returned no listings but we previously had some — kept previous data',
          suspectSession: false,
        }
      }
      const rows: MyListingRow[] = listings.map((l) => ({
        listingid: l.listingid,
        assetid: l.assetid ?? '',
        market_hash_name: l.market_hash_name ?? l.name ?? '',
        price_cents: l.price_cents ?? null,
        updated_at: new Date().toISOString(),
      }))
      replaceMyListings(rows)
      const confirmed = resolveConfirmed()
      console.info(`[listings] ${rows.length} active${confirmed.length ? `, ${confirmed.length} pending sell(s) confirmed` : ''}`)
      return { ok: true, total: rows.length, confirmed }
    } catch (err) {
      return { ok: false, keptPrevious: true, error: (err as Error).message, suspectSession: true }
    }
  })()
  inflight = run
  // Clear the slot once settled so the next caller starts a fresh request.
  return run.finally(() => {
    if (inflight === run) inflight = null
  })
}

// A pending sell is confirmed the moment its asset appears in the live listing
// set. Matched strictly on assetid: falling back to market_hash_name would
// resolve against one of your duplicate items ("Charm | Lil' SAS" x6) and clear
// the badge on the wrong card.
function resolveConfirmed(): string[] {
  const listed = new Set(listMyListings().map((l) => l.assetid).filter((id) => !!id))
  const confirmed = listPendingListings().filter((p) => listed.has(p.assetid)).map((p) => p.assetid)
  deletePendingListings(confirmed)
  return confirmed
}

/**
 * Record a sell Steam accepted but has not turned into a listing yet, and make
 * sure something is watching for it to resolve. Safe to call repeatedly for the
 * same asset (a re-list supersedes the previous attempt).
 */
export function markPendingSell(input: { assetid: string; market_hash_name: string | null; price_cents: number | null }): void {
  upsertPendingListing(input)
  console.info(`[listings] sell pending mobile approval: ${input.assetid}`)
  ensureReconciler()
}

/** Forget a pending sell so the item can be listed again (retry after a decline). */
export function clearPendingSell(assetid: string): void {
  deletePendingListings([assetid])
}

export function pendingByAssetId(): Map<string, PendingListingRow> {
  return new Map(listPendingListings().map((p) => [p.assetid, p]))
}

function pendingPast(cutoff: number): string[] {
  return listPendingListings()
    .filter((p) => new Date(p.created_at).getTime() < cutoff)
    .map((p) => p.assetid)
}

function pruneExpiredPending(): PendingListingRow[] {
  const rows = listPendingListings()
  if (rows.length === 0) return rows
  const expired = pendingPast(Date.now() - PENDING_TTL_MS)
  deletePendingListings(expired)
  if (expired.length > 0) {
    console.warn(`[listings] gave up on ${expired.length} pending sell(s) older than ${PENDING_TTL_MS}ms with no listing`)
  }
  return rows.filter((r) => !expired.includes(r.assetid))
}

// Detect rejections. A sell that Steam is still offering to take to market has
// not been committed to, so once the grace window has passed the item is
// sellable again and the UI should say so instead of waiting forever.
async function markDeclined(): Promise<void> {
  const cutoff = Date.now() - DECLINE_GRACE_MS
  const candidates = listPendingListings().filter(
    (p) => p.state === 'awaiting' && new Date(p.created_at).getTime() <= cutoff,
  )
  if (candidates.length === 0) return
  const stillSellable = await steam.activeSellability(candidates.map((p) => p.assetid))
  const declined = candidates.filter((p) => stillSellable.get(p.assetid) === true).map((p) => p.assetid)
  if (declined.length === 0) return
  setPendingListingState(declined, 'declined')
  console.info(`[listings] ${declined.length} pending sell(s) rejected or expired: ${declined.join(', ')}`)
}

let loop: Promise<void> | null = null

/** Start the shared reconcile loop if it isn't already watching. */
export function ensureReconciler(): void {
  if (loop) return
  const run = (async () => {
    for (let attempt = 0; ; attempt++) {
      if (pruneExpiredPending().length === 0) return
      await sleep(Math.min(RECONCILE_MAX_DELAY_MS, RECONCILE_MIN_DELAY_MS * RECONCILE_BACKOFF ** attempt))
      try {
        await refreshListings()
      } catch (err) {
        console.warn('[listings] reconcile refresh failed:', (err as Error).message)
      }
      try {
        await markDeclined()
      } catch (err) {
        console.warn('[listings] decline check failed:', (err as Error).message)
      }
    }
  })()
  loop = run
  void run.finally(() => {
    if (loop === run) loop = null
  })
}

/**
 * Drop a cancelled listing from the cache immediately so the grid stops showing
 * it as listed, then reconcile against Steam to confirm it really is gone.
 */
export function forgetListing(listingid: string): void {
  deleteMyListing(listingid)
}