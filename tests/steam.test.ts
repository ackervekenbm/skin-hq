import { describe, expect, it, vi } from 'vitest'

const dbMock = vi.hoisted(() => ({
  clearSession: vi.fn(),
  loadSession: vi.fn(() => undefined),
  saveSession: vi.fn(),
  upsertItems: vi.fn(),
}))

vi.mock('../src/server/db', () => dbMock)

import { parsePriceToCents } from '../src/server/steam'

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