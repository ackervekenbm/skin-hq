// Seller/buyer fee math for the Steam and CSFloat markets.
//
// Values verified against public fee schedules (Sep 2026):
//   Steam:  5% Steam transaction fee + 10% CS2 publisher fee, each floored to
//           a $0.01 minimum per component, charged ON the seller's amount.
//           The price shown to buyers (priceoverview "lowest_price", the market
//           floor, sale medians) is the buyer-facing total; the seller receives
//           the net.
//   CSFloat: 2% seller fee deducted from the sale price; 0% buyer side.
//
// Lives in shared/ because the client needs the same numbers the server uses:
// the sell box takes a seller ask, while every price we display (floor,
// median, top buy) is buyer-facing, so turning one into the other has to use
// this math or the quick-price chips are quietly wrong.

const STEAM_NET_PCT = 0.05
const STEAM_GAME_PCT = 0.1
const STEAM_MIN_FEE_CENTS = 1

export function steamBuyerPriceFromSeller(sellerCents: number): number {
  const net = Math.floor(sellerCents * STEAM_NET_PCT)
  const game = Math.floor(sellerCents * STEAM_GAME_PCT)
  return sellerCents + Math.max(STEAM_MIN_FEE_CENTS, net) + Math.max(STEAM_MIN_FEE_CENTS, game)
}

// Inverse of steamBuyerPriceFromSeller: given a buyer-facing price (what
// priceoverview reports), return the Steam-wallet amount the seller nets.
// This is the ask you type into the sell box to land on that buyer price.
export function steamNetFromBuyerPrice(buyerCents: number): number {
  if (!Number.isFinite(buyerCents) || buyerCents <= 0) return 0
  // Buyer price is strictly increasing in seller amount, so binary-search for
  // the largest seller net whose buyer price does not exceed the input.
  let lo = 0
  let hi = buyerCents
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (steamBuyerPriceFromSeller(mid) <= buyerCents) lo = mid
    else hi = mid - 1
  }
  return lo
}

// CSFloat 2% seller fee, deducted from the sale price.
export function csfloatNetFromPrice(priceCents: number): number {
  if (!Number.isFinite(priceCents) || priceCents <= 0) return 0
  return Math.floor(priceCents * 0.98)
}