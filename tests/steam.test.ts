import { describe, expect, it, vi } from 'vitest'

const dbMock = vi.hoisted(() => ({
  clearSession: vi.fn(),
  loadSession: vi.fn(() => undefined),
  saveSession: vi.fn(),
  upsertItems: vi.fn(),
}))

vi.mock('../src/server/db', () => dbMock)

import { nextPropertiesPage, parsePriceToCents } from '../src/server/steam'

describe('parsePriceToCents', () => {
  it.each([
    ['€6,45', 645],
    ['€ 1.234,56', 123456],
    ['$1,234.56', 123456],
    ['$ 100', 10000],
    ['6.45 €', 645],
    ['€664,50', 66450],
  ])('parses "%s" → %i', (text, cents) => {
    expect(parsePriceToCents(text)).toBe(cents)
  })

  it('treats a bare thousands separator as ambiguous (null)', () => {
    expect(parsePriceToCents('$1,000')).toBeNull()
  })

  it('returns null for empty or ambiguous inputs', () => {
    expect(parsePriceToCents('')).toBeNull()
    expect(parsePriceToCents('n/a')).toBeNull()
    expect(parsePriceToCents('0')).toBeNull()
    expect(parsePriceToCents('€0,00')).toBeNull()
  })
})

describe('nextPropertiesPage', () => {
  it('returns entries and the continuation token when more_items is set', () => {
    expect(
      nextPropertiesPage({
        success: 1,
        asset_properties: [{ assetid: 'a' }, { assetid: 'b' }],
        more_items: true,
        more_start_assetid: 'b',
      }),
    ).toEqual({ entries: [{ assetid: 'a' }, { assetid: 'b' }], next: 'b' })
  })

  it('accepts Steam\'s numeric more_items (1) and the legacy last_assetid fallback', () => {
    expect(
      nextPropertiesPage({ success: true, asset_properties: [], more_items: 1, last_assetid: 'z' }),
    ).toEqual({ entries: [], next: 'z' })
  })

  it('returns empty + null for a failed page and for a terminal page', () => {
    expect(nextPropertiesPage({ success: 0 })).toEqual({ entries: [], next: null })
    expect(nextPropertiesPage({ success: 1, asset_properties: [], more_items: 0 })).toEqual({ entries: [], next: null })
  })

  it('never fabricates a continuation token from a malformed page', () => {
    expect(nextPropertiesPage({ success: 1, more_items: true, more_start_assetid: 123 })).toEqual({
      entries: [],
      next: null,
    })
    expect(nextPropertiesPage({ success: 1, more_items: 'yes' })).toEqual({ entries: [], next: null })
  })
})