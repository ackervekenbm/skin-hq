import { latestPriceSnapshots, listItems, listMyListings, type PriceSnapshotRow } from './db'
import { csfloatNetFromPrice, steamNetFromBuyerPrice, toUsdCents } from './fees'

export interface CompareSide {
  provider: 'steam' | 'csfloat'
  currency: 'EUR' | 'USD'
  lowest_cents: number | null
  net_cents: number | null
  volume?: number | null
  sell_count?: number | null
  buy_count?: number | null
  highest_buy_cents?: number | null
  float_value?: number | null
  paint_seed?: number | null
  stickers?: Array<{ name: string; slot: number }> | null
  error?: string
  fetched_at: string | null
}

export interface CompareRow {
  hash: string
  name: string
  icon_url: string
  listed: boolean
  listing_price_cents: number | null
  steam: CompareSide
  csfloat: CompareSide | null
  // What a sell nets in a single comparable currency (USD), for the spread math.
  netUsd: { steam: number | null; csfloat: number | null }
  // Which venue nets more after its fees. Null if either side is missing.
  deltaPercent: number | null
  bestVenue: 'steam' | 'csfloat' | null
}

function parseStickers(raw: string | null): CompareSide['stickers'] {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Array<{ name: string; slot: number }>
    return Array.isArray(parsed) ? parsed.filter((s) => !!s.name) : null
  } catch {
    return null
  }
}

export function buildCompare(hash: string): CompareRow | null {
  const item = listItems().find((i) => i.market_hash_name === hash)
  if (!item) return null

  const { byItem } = latestPriceSnapshots()
  const snapshots = byItem.get(hash) ?? new Map<string, PriceSnapshotRow>()

  const listing = listMyListings()
    .filter((l) => l.market_hash_name === hash)
    .sort((a, b) => (a.price_cents ?? Infinity) - (b.price_cents ?? Infinity))[0]

  const steam: PriceSnapshotRow | undefined = snapshots.get('steam')
  const csfloat: PriceSnapshotRow | undefined = snapshots.get('csfloat')

  const steamLowest = steam?.lowest_cents ?? null
  const csfloatLowest = csfloat?.lowest_cents ?? null

  const steamNet = steamLowest != null ? steamNetFromBuyerPrice(steamLowest) : null
  const csfloatNet = csfloatLowest != null ? csfloatNetFromPrice(csfloatLowest) : null

  const steamSide: CompareSide = {
    provider: 'steam',
    currency: 'EUR',
    lowest_cents: steamLowest,
    net_cents: steamNet,
    volume: steam?.volume ?? null,
    sell_count: steam?.sell_count ?? null,
    buy_count: steam?.buy_count ?? null,
    highest_buy_cents: steam?.highest_buy_cents ?? null,
    error: steam?.had_error ? (steam?.note ?? 'no data') : undefined,
    fetched_at: steam?.fetched_at ?? null,
  }

  let csfloatSide: CompareSide | null = null
  if (csfloat) {
    csfloatSide = {
      provider: 'csfloat',
      currency: 'USD',
      lowest_cents: csfloatLowest,
      net_cents: csfloatNet,
      volume: csfloat?.volume ?? null,
      float_value: csfloat?.float_value ?? null,
      paint_seed: csfloat?.paint_seed ?? null,
      stickers: parseStickers(csfloat?.stickers ?? null),
      error: csfloat.had_error ? (csfloat.note ?? 'no data') : undefined,
      fetched_at: csfloat.fetched_at,
    }
  }

  const steamNetUsd = steamNet != null ? toUsdCents(steamNet, 'EUR') : null
  const csfloatNetUsd = csfloatNet != null ? toUsdCents(csfloatNet, 'USD') : null

  let deltaPercent: number | null = null
  let bestVenue: CompareRow['bestVenue'] = null
  if (steamNetUsd != null && csfloatNetUsd != null) {
    deltaPercent = ((csfloatNetUsd - steamNetUsd) / steamNetUsd) * 100
    bestVenue = csfloatNetUsd > steamNetUsd ? 'csfloat' : steamNetUsd > csfloatNetUsd ? 'steam' : bestVenue
  }

  return {
    hash,
    name: item.name ?? hash,
    icon_url: item.icon_url ?? '',
    listed: !!listing,
    listing_price_cents: listing?.price_cents ?? null,
    steam: steamSide,
    csfloat: csfloatSide,
    netUsd: { steam: steamNetUsd, csfloat: csfloatNetUsd },
    deltaPercent,
    bestVenue,
  }
}