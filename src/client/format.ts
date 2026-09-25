export interface StickerRef {
  name: string
  slot: number
}

export interface GridPrice {
  provider: string
  lowest_cents: number | null
  median_cents: number | null
  volume: number | null
  sell_count: number | null
  buy_count: number | null
  highest_buy_cents: number | null
  float_value: number | null
  paint_seed: number | null
  stickers: string | null
  had_error: number
  note?: string | null
  fetched_at: string
}

export function formatEuro(cents: number | null | undefined): string {
  if (cents == null) return '—'
  return `€${(cents / 100).toFixed(2)}`
}

export function formatAmount(cents: number, currency: 'EUR' | 'USD'): string {
  return `${currency === 'USD' ? '$' : '€'}${(cents / 100).toFixed(2)}`
}

export function formatGridPrice(p: GridPrice | null | undefined): string {
  if (!p || p.lowest_cents == null) {
    // Steam returns a "0,00 €" placeholder for lowest_price when nothing is
    // actively listed even though the item still trades (median/volume are
    // real). A successful fetch with no lowest is "no listings", not "no
    // data" — surface that state instead of a bare dash.
    return p && p.had_error === 0 ? 'no listings' : '—'
  }
  return formatAmount(p.lowest_cents, p.provider === 'csfloat' ? 'USD' : 'EUR')
}

export function formatFloat(f: number | null | undefined): string {
  if (f == null) return '—'
  return f.toFixed(4)
}

export function parseStickers(raw: string | null | undefined): StickerRef[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as StickerRef[]
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

export function formatAutoSyncMin(min: number): string {
  return min % 60 === 0 ? `auto-sync every ${min / 60}h` : `auto-sync every ${min}m`
}

export function wearOf(hash: string): string {
  const m = hash.match(/\(([^)]+)\)$/)
  return m ? m[1] : ''
}

export function isStatTrak(name: string, hash: string): boolean {
  return /^StatTrak/i.test(name) || /^StatTrak/i.test(hash)
}

export function baseName(name: string): string {
  return name.replace(/^StatTrak\u2122?\s*/i, '').replace(/\s*\([^)]+\)$/, '').trim()
}

function eurosFromNumber(cleaned: string): number | null {
  const amount = Number(cleaned)
  if (!Number.isFinite(amount) || amount <= 0) return null
  const cents = Math.round(amount * 100)
  return cents > 0 ? cents : null
}

export function eurosToCents(input: string): number | null {
  const text = input.trim().replace(/[€\s]/g, '')
  if (!text) return null
  const commaCount = (text.match(/,/g) ?? []).length
  const dotCount = (text.match(/\./g) ?? []).length
  if (commaCount + dotCount > 1) {
    // Multiple separators (e.g. "1.234,56" or "12.345,678"): the LAST one is
    // the decimal separator, the rest are thousands groups.
    const lastIdx = Math.max(text.lastIndexOf('.'), text.lastIndexOf(','))
    const cleaned = text.slice(0, lastIdx).replace(/[.,]/g, '') + text.slice(lastIdx).replace(',', '.')
    return eurosFromNumber(cleaned)
  }
  if (commaCount === 1) {
    // "12,50" is decimal euro notation.
    return eurosFromNumber(text.replace(',', '.'))
  }
  if (dotCount === 1) {
    // A lone dot is ambiguous: "12.50" is a decimal point, but exactly
    // three fraction digits normally means a thousands group ("1.234" = 1234).
    const [intPart, fracPart] = text.split('.')
    if (fracPart && fracPart.length === 3 && intPart && intPart !== '0') {
      return eurosFromNumber(intPart + fracPart)
    }
    return eurosFromNumber(text)
  }
  return eurosFromNumber(text)
}