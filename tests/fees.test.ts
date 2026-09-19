import { describe, expect, it } from 'vitest'
import {
  csfloatNetFromPrice,
  steamBuyerPriceFromSeller,
  steamNetFromBuyerPrice,
  toUsdCents,
  toEurCents,
} from '../src/server/fees'

describe('steamBuyerPriceFromSeller', () => {
  it('charges the 5% transaction fee and 10% publisher fee on top', () => {
    expect(steamBuyerPriceFromSeller(10000)).toBe(10000 + 500 + 1000)
  })

  it('floors each fee component at $0.01', () => {
    expect(steamBuyerPriceFromSeller(1)).toBe(3)
    expect(steamBuyerPriceFromSeller(10)).toBe(12)
  })
})

describe('steamNetFromBuyerPrice', () => {
  it('inverts the buyer price back to the seller net', () => {
    expect(steamNetFromBuyerPrice(steamBuyerPriceFromSeller(10000))).toBe(10000)
    expect(steamNetFromBuyerPrice(steamBuyerPriceFromSeller(1))).toBe(1)
  })

  it('matches the live compare value for the Skeleton Knife listing', () => {
    expect(steamNetFromBuyerPrice(76960)).toBe(66922)
  })

  it('returns 0 for non-positive or non-finite inputs', () => {
    expect(steamNetFromBuyerPrice(0)).toBe(0)
    expect(steamNetFromBuyerPrice(-500)).toBe(0)
    expect(steamNetFromBuyerPrice(Number.NaN)).toBe(0)
    expect(steamNetFromBuyerPrice(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('csfloatNetFromPrice', () => {
  it('deducts the 2% seller fee', () => {
    expect(csfloatNetFromPrice(10000)).toBe(9800)
    expect(csfloatNetFromPrice(56000)).toBe(54880)
  })

  it('returns 0 for non-positive input', () => {
    expect(csfloatNetFromPrice(0)).toBe(0)
    expect(csfloatNetFromPrice(-1)).toBe(0)
  })
})

describe('currency conversion', () => {
  it('converts EUR to USD at the default 1.1 rate', () => {
    expect(toUsdCents(100, 'EUR')).toBe(110)
    expect(toUsdCents(100, 'USD')).toBe(100)
  })

  it('converts USD back to EUR', () => {
    expect(toEurCents(110, 'USD')).toBe(100)
    expect(toEurCents(100, 'EUR')).toBe(100)
    expect(toEurCents(66921, 'USD')).toBe(60837)
  })
})