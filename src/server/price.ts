import { marketOrderSpread, priceOverview } from './steam'

export interface StickerRef {
  name: string
  slot: number
  image_url?: string
  float_value?: number
  wear?: number
}

export interface ItemPrice {
  provider: string
  currency: string
  lowest_cents: number | null
  median_cents?: number | null
  volume?: number
  sell_count?: number
  buy_count?: number
  highest_buy_cents?: number | null
  float_value?: number | null
  paint_seed?: number | null
  stickers?: StickerRef[] | null
  error?: string
}

export interface PriceProvider {
  name: string
  getItem(hashName: string): Promise<ItemPrice>
}

class SteamProvider implements PriceProvider {
  readonly name = 'steam'

  async getItem(hashName: string): Promise<ItemPrice> {
    try {
      const [overview, spread] = await Promise.allSettled([priceOverview(hashName), marketOrderSpread(hashName)])
      const ov = overview.status === 'fulfilled' ? overview.value : null
      const det = spread.status === 'fulfilled' ? spread.value : null
      return {
        provider: this.name,
        currency: 'EUR',
        lowest_cents: det?.lowest_sell_cents ?? ov?.lowest_cents ?? null,
        median_cents: ov?.median_cents ?? null,
        volume: ov?.volume ?? undefined,
        sell_count: det?.sell_count ?? undefined,
        buy_count: det?.buy_count ?? undefined,
        highest_buy_cents: det?.highest_buy_cents ?? null,
        error: ov?.success || det ? undefined : 'no listing data',
      }
    } catch (err) {
      return { provider: this.name, currency: 'EUR', lowest_cents: null, error: (err as Error).message }
    }
  }
}

interface CSFloatSticker {
  name?: string
  slot?: number
  image_url?: string
  float_value?: number
  wear?: number
}

interface CSFloatListingItem {
  float_value?: number
  paint_seed?: number
  keychains?: CSFloatSticker[]
  stickers?: CSFloatSticker[]
}

interface CSFloatListing {
  price?: number
  item?: CSFloatListingItem
}

function mapStickers(item: CSFloatListingItem | undefined): StickerRef[] | null {
  if (!item) return null
  const rows = item.stickers ?? item.keychains ?? []
  if (!rows.length) return null
  return rows
    .filter((s) => !!s.name)
    .map((s) => {
      const ref: StickerRef = { name: String(s.name), slot: s.slot ?? 0, image_url: s.image_url }
      if (s.float_value != null) ref.float_value = s.float_value
      if (s.wear != null) ref.wear = s.wear
      return ref
    })
}

class CSFloatProvider implements PriceProvider {
  readonly name = 'csfloat'

  async getItem(hashName: string): Promise<ItemPrice> {
    try {
      const apiKey = process.env.CSFLOAT_API_KEY
      if (!apiKey) {
        return { provider: this.name, currency: 'USD', lowest_cents: null, error: 'no CSFLOAT_API_KEY configured' }
      }
      const url = `https://csfloat.com/api/v1/listings?market_hash_name=${encodeURIComponent(hashName)}&limit=1&sort_by=lowest_price&type=buy_now`
      const res = await fetch(url, {
        headers: { Accept: 'application/json', Authorization: apiKey },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) {
        return { provider: this.name, currency: 'USD', lowest_cents: null, error: `HTTP ${res.status}` }
      }
      const payload = (await res.json()) as { data?: CSFloatListing[]; message?: string }
      const listings = Array.isArray(payload?.data) ? payload.data : []
      if (!listings.length && typeof payload.message === 'string') {
        return { provider: this.name, currency: 'USD', lowest_cents: null, error: `unexpected response: ${payload.message}` }
      }
      const lowest = listings.filter((l) => typeof l.price === 'number').reduce<number>((min, l) => Math.min(min, l.price as number), Infinity)
      const first = listings[0]
      return {
        provider: this.name,
        currency: 'USD',
        lowest_cents: Number.isFinite(lowest) ? lowest : null,
        float_value: first?.item?.float_value ?? null,
        paint_seed: first?.item?.paint_seed ?? null,
        stickers: mapStickers(first?.item),
      }
    } catch (err) {
      return { provider: this.name, currency: 'USD', lowest_cents: null, error: (err as Error).message }
    }
  }
}

export const providers: PriceProvider[] = [new SteamProvider(), new CSFloatProvider()]

export async function comparePrices(hashName: string): Promise<ItemPrice[]> {
  return Promise.all(providers.map((p) => p.getItem(hashName)))
}