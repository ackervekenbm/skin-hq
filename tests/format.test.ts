import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  baseName,
  centsToEuros,
  eurosToCents,
  formatAmount,
  formatAutoSyncMin,
  formatEuro,
  formatFloat,
  formatGridPrice,
  isStatTrak,
  parseStickers,
  quickPrices,
  relTime,
  wearOf,
  type GridPrice,
} from '../src/client/format'
import { steamBuyerPriceFromSeller } from '../src/shared/fees'

describe('eurosToCents', () => {
  it('parses plain integer and dot/comma decimals', () => {
    expect(eurosToCents('12')).toBe(1200)
    expect(eurosToCents('12.50')).toBe(1250)
    expect(eurosToCents('12,50')).toBe(1250)
    expect(eurosToCents('0.99')).toBe(99)
  })

  it('strips euro signs and whitespace', () => {
    expect(eurosToCents('€12.50')).toBe(1250)
    expect(eurosToCents(' 12,50 € ')).toBe(1250)
  })

  it('treats the last of multiple separators as the decimal point', () => {
    expect(eurosToCents('1.234,56')).toBe(123456)
    expect(eurosToCents('12.345,678')).toBe(1234568)
    expect(eurosToCents('1,234.56')).toBe(123456)
  })

  it('reads a lone dot followed by 3 digits as a thousands group', () => {
    expect(eurosToCents('1.234')).toBe(123400)
    expect(eurosToCents('12.345')).toBe(1234500)
  })

  it('treats a lone comma as a decimal point (European notation)', () => {
    expect(eurosToCents('2,55')).toBe(255)
  })

  it('rejects empty, non-numeric and non-positive input', () => {
    expect(eurosToCents('')).toBeNull()
    expect(eurosToCents('   ')).toBeNull()
    expect(eurosToCents('abc')).toBeNull()
    expect(eurosToCents('0')).toBeNull()
    expect(eurosToCents('-5')).toBeNull()
    expect(eurosToCents('0.001')).toBeNull()
  })
})

describe('formatEuro / formatAmount', () => {
  it('formats euro cents', () => {
    expect(formatEuro(12345)).toBe('€123.45')
    expect(formatEuro(null)).toBe('—')
  })

  it('routes the currency symbol correctly', () => {
    expect(formatAmount(1250, 'EUR')).toBe('€12.50')
    expect(formatAmount(1250, 'USD')).toBe('$12.50')
  })
})

describe('formatGridPrice', () => {
  const base: GridPrice = {
    provider: 'steam',
    lowest_cents: null,
    median_cents: null,
    volume: null,
    sell_count: null,
    buy_count: null,
    highest_buy_cents: null,
    float_value: null,
    paint_seed: null,
    stickers: null,
    had_error: 0,
    fetched_at: '2026-01-01T00:00:00Z',
  }

  it('distinguishes an empty successful fetch from a missing/dashed one', () => {
    expect(formatGridPrice(null)).toBe('—')
    expect(formatGridPrice({ ...base, had_error: 1 })).toBe('—')
    expect(formatGridPrice({ ...base, had_error: 0 })).toBe('no listings')
  })

  it('formats a real lowest price with the provider currency', () => {
    expect(formatGridPrice({ ...base, provider: 'steam', lowest_cents: 2450 })).toBe('€24.50')
    expect(formatGridPrice({ ...base, provider: 'csfloat', lowest_cents: 2450 })).toBe('$24.50')
  })
})

describe('formatFloat', () => {
  it('prints four decimals and a dash for missing floats', () => {
    expect(formatFloat(0.123456)).toBe('0.1235')
    expect(formatFloat(0.1234)).toBe('0.1234')
    expect(formatFloat(null)).toBe('—')
  })
})

describe('parseStickers', () => {
  it('returns an empty list for empty, malformed or non-array payloads', () => {
    expect(parseStickers(null)).toEqual([])
    expect(parseStickers(undefined)).toEqual([])
    expect(parseStickers('not json')).toEqual([])
    expect(parseStickers('{"name":"x"}')).toEqual([])
  })

  it('parses a valid sticker array', () => {
    expect(parseStickers('[{"name":"Natus Vincere | Katowice 2019","slot":1}]')).toEqual([
      { name: 'Natus Vincere | Katowice 2019', slot: 1 },
    ])
  })
})

describe('relTime', () => {
  const now = new Date('2026-01-01T12:00:00Z')

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('handles missing timestamps', () => {
    expect(relTime(null)).toBe('—')
  })

  it('buckets into seconds, minutes and hours', () => {
    expect(relTime(new Date(now.getTime() - 30_000).toISOString())).toBe('30s ago')
    expect(relTime(new Date(now.getTime() - 90_000).toISOString())).toBe('1m ago')
    expect(relTime(new Date(now.getTime() - 4000_000).toISOString())).toBe('1h ago')
    expect(relTime(new Date(now.getTime() - 7200_000).toISOString())).toBe('2h ago')
  })
})

describe('formatAutoSyncMin', () => {
  it('switches between minutes and hours on the 60-minute boundary', () => {
    expect(formatAutoSyncMin(30)).toBe('auto-sync every 30m')
    expect(formatAutoSyncMin(60)).toBe('auto-sync every 1h')
    expect(formatAutoSyncMin(180)).toBe('auto-sync every 3h')
  })
})

describe('wearOf / isStatTrak / baseName', () => {
  it('extracts the wear from a market hash', () => {
    expect(wearOf('AK-47 | Redline (Field-Tested)')).toBe('Field-Tested')
    expect(wearOf('AK-47 | Redline')).toBe('')
  })

  it('flags StatTrak items by name or hash', () => {
    expect(isStatTrak('StatTrak AK-47 | Redline', 'AK-47 | Redline')).toBe(true)
    expect(isStatTrak('AK-47 | Redline', 'StatTrak AK-47 | Redline')).toBe(true)
    expect(isStatTrak('AK-47 | Redline', 'AK-47 | Redline')).toBe(false)
  })

  it('strips the StatTrak prefix and wear suffix from display names', () => {
    expect(baseName('StatTrak\u2122 AK-47 | Redline (Field-Tested)')).toBe('AK-47 | Redline')
    expect(baseName('AWP | Dragon Lore (Factory New)')).toBe('AWP | Dragon Lore')
    expect(baseName('M4A1-S | Cyrex')).toBe('M4A1-S | Cyrex')
  })
})
describe('centsToEuros', () => {
  it('round-trips through eurosToCents', () => {
    for (const cents of [1, 99, 100, 1250, 999999]) {
      expect(eurosToCents(centsToEuros(cents))).toBe(cents)
    }
  })
})

describe('quickPrices', () => {
  function steam(over: Partial<GridPrice> = {}): GridPrice {
    return {
      provider: 'steam',
      lowest_cents: 1250,
      median_cents: 1400,
      volume: 10,
      sell_count: null,
      buy_count: null,
      highest_buy_cents: 1100,
      float_value: null,
      paint_seed: null,
      stickers: null,
      had_error: 0,
      fetched_at: '2026-09-25T00:00:00Z',
      ...over,
    }
  }

  it('returns nothing when there is no usable Steam snapshot', () => {
    expect(quickPrices(null)).toEqual([])
    expect(quickPrices(undefined)).toEqual([])
    expect(quickPrices(steam({ provider: 'csfloat' }))).toEqual([])
    expect(quickPrices(steam({ lowest_cents: null, median_cents: null, highest_buy_cents: null }))).toEqual([])
    expect(quickPrices(steam({ had_error: 1, lowest_cents: null, median_cents: null, highest_buy_cents: null }))).toEqual([])
  })

  it('offers floor, undercut, median and top buy', () => {
    expect(quickPrices(steam()).map((c) => c.label)).toEqual(['Match floor', 'Undercut', 'At median', 'At top buy'])
  })

  it('omits chips for references the snapshot does not have', () => {
    expect(quickPrices(steam({ median_cents: null, highest_buy_cents: null })).map((c) => c.label)).toEqual([
      'Match floor',
      'Undercut',
    ])
    expect(quickPrices(steam({ lowest_cents: null })).map((c) => c.label)).toEqual(['At median', 'At top buy'])
  })

  // The whole point of the chips: the sell box takes what the seller asks, while
  // every price on screen is what the buyer pays. Steam adds ~15% on top of the
  // ask, so pasting the floor into the box would put you ABOVE the floor, not on
  // it. Each ask has to convert back to the price it was derived from.
  it('produces asks that actually land on the displayed buyer price', () => {
    const chips = quickPrices(steam())
    const byLabel = new Map(chips.map((c) => [c.label, c.cents]))
    expect(steamBuyerPriceFromSeller(byLabel.get('Match floor')!)).toBe(1250)
    expect(steamBuyerPriceFromSeller(byLabel.get('At median')!)).toBe(1400)
    expect(steamBuyerPriceFromSeller(byLabel.get('At top buy')!)).toBe(1100)
  })

  it('undercuts the floor by exactly one cent', () => {
    const chips = quickPrices(steam())
    const floor = chips.find((c) => c.label === 'Match floor')!.cents
    const under = chips.find((c) => c.label === 'Undercut')!.cents
    expect(floor - under).toBe(1)
    // And the undercut really is cheaper for a buyer than the current floor.
    expect(steamBuyerPriceFromSeller(under)).toBeLessThan(1250)
  })

  it('offers nothing for a floor too low for any valid seller ask', () => {
    // Steam's minimum fee alone exceeds a one-cent buyer price, so there is no
    // ask that lands on it — better to offer no chip than a wrong one.
    expect(quickPrices(steam({ lowest_cents: 1, median_cents: null, highest_buy_cents: null }))).toEqual([])
  })

  it('ignores non-positive references', () => {
    expect(quickPrices(steam({ median_cents: 0, highest_buy_cents: -5 })).map((c) => c.label)).toEqual([
      'Match floor',
      'Undercut',
    ])
  })

  it('gives every chip a title so the number is explainable on hover', () => {
    expect(quickPrices(steam()).every((c) => c.title.length > 0)).toBe(true)
  })
})

describe('quickPrices floor invariants', () => {
  function steamFloor(floor: number): GridPrice {
    return {
      provider: 'steam',
      lowest_cents: floor,
      median_cents: null,
      volume: null,
      sell_count: null,
      buy_count: null,
      highest_buy_cents: null,
      float_value: null,
      paint_seed: null,
      stickers: null,
      had_error: 0,
      fetched_at: '2026-09-25T00:00:00Z',
    }
  }

  it('never produces a zero or negative ask across the realistic range', () => {
    for (let floor = 1; floor <= 50_000; floor = floor < 200 ? floor + 1 : Math.ceil(floor * 1.37)) {
      for (const chip of quickPrices(steamFloor(floor))) {
        expect(chip.cents).toBeGreaterThan(0)
      }
    }
  })

  it('match floor lands on the displayed floor or just under it', () => {
    for (const floor of [150, 999, 1250, 4999, 123456]) {
      const match = quickPrices(steamFloor(floor)).find((c) => c.label === 'Match floor')!
      expect(match).toBeDefined()
      const buyerPrice = steamBuyerPriceFromSeller(match.cents)
      expect(buyerPrice).toBeLessThanOrEqual(floor)
      expect(buyerPrice).toBeGreaterThan(floor - 20)
    }
  })
})
