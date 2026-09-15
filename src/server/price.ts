import { marketItemDetail, priceOverview } from './steam'

export interface ItemPrice {
  provider: string
  currency: string
  lowest_cents: number | null
  volume?: number
  sell_count?: number
  buy_count?: number
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
      const [overview, detail] = await Promise.allSettled([priceOverview(hashName), marketItemDetail(hashName)])
      const ov = overview.status === 'fulfilled' ? overview.value : null
      const det = detail.status === 'fulfilled' ? detail.value : null
      return {
        provider: this.name,
        currency: 'EUR',
        lowest_cents: det?.lowest_cents ?? ov?.lowest_cents ?? null,
        volume: ov?.volume ?? undefined,
        sell_count: det?.quantity ?? undefined,
        buy_count: det?.buy_quantity ?? undefined,
        error: ov?.success || det ? undefined : 'no listing data',
      }
    } catch (err) {
      return { provider: this.name, currency: 'EUR', lowest_cents: null, error: (err as Error).message }
    }
  }
}

class CSFloatProvider implements PriceProvider {
  readonly name = 'csfloat'

  async getItem(hashName: string): Promise<ItemPrice> {
    try {
      const url = `https://csfloat.com/api/v1/listings?market_hash_name=${encodeURIComponent(hashName)}&limit=1&sort_by=price`
      const res = await fetch(url, { headers: { Accept: 'application/json' } })
      if (!res.ok) {
        return { provider: this.name, currency: 'USD', lowest_cents: null, error: `HTTP ${res.status}` }
      }
      const listings = (await res.json()) as { price?: number }[]
      const lowest = listings.filter((l) => typeof l.price === 'number').reduce<number>((min, l) => Math.min(min, l.price as number), Infinity)
      return { provider: this.name, currency: 'USD', lowest_cents: Number.isFinite(lowest) ? lowest : null }
    } catch (err) {
      return { provider: this.name, currency: 'USD', lowest_cents: null, error: (err as Error).message }
    }
  }
}

export const providers: PriceProvider[] = [new SteamProvider(), new CSFloatProvider()]

export async function comparePrices(hashName: string): Promise<ItemPrice[]> {
  return Promise.all(providers.map((p) => p.getItem(hashName)))
}