// Server-side currency helpers. The market fee math those depend on lives in
// shared/fees.ts, which the client also uses.

export { csfloatNetFromPrice, steamBuyerPriceFromSeller, steamNetFromBuyerPrice } from '../shared/fees'

// Configurable EUR -> USD rate, e.g. "1.10" = 1 EUR buys 1.10 USD.
const FX_EUR_USD = Number(process.env.FX_EUR_USD ?? 1.1)

export function toUsdCents(cents: number, currency: 'EUR' | 'USD'): number {
  if (currency === 'USD') return cents
  return Math.round(cents * FX_EUR_USD)
}

export function toEurCents(cents: number, currency: 'EUR' | 'USD'): number {
  if (currency === 'EUR') return cents
  return Math.round(cents / FX_EUR_USD)
}