import { describe, expect, it } from 'vitest'
import { filterItems, type FilterableItem } from '../src/client/filter'

function item(name: string, over: Partial<FilterableItem> = {}): FilterableItem & { id: string } {
  return {
    id: name,
    name,
    market_hash_name: name,
    listing: null,
    pending: null,
    marketable: true,
    rarity: null,
    own: null,
    ...over,
  }
}

const vulcan = item('AK-47 | Vulcan (Factory New)', { rarity: { name: 'Covert' } })
const redline = item('StatTrak™ AK-47 | Redline (Field-Tested)', {
  listing: { listingid: '1', price_cents: 900 },
  own: { stickers: JSON.stringify({ stickers: [{ name: 'Crown (Foil)' }], keychains: [{ name: 'Lil Squirt' }] }) },
})
const awp = item('AWP | Asiimov (Battle-Scarred)', { pending: { state: 'awaiting', price_cents: 1, created_at: '' } })
const case_ = item('Kilowatt Case', { marketable: false })
const all = [vulcan, redline, awp, case_]
const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id)

describe('filterItems', () => {
  it('returns everything for an empty query and "all"', () => {
    expect(filterItems(all, '  ', 'all')).toEqual(all)
  })

  it('matches every word, in any order, case-insensitively', () => {
    expect(ids(filterItems(all, 'ak', 'all'))).toEqual([vulcan.id, redline.id])
    expect(ids(filterItems(all, 'REDLINE ak', 'all'))).toEqual([redline.id])
    expect(filterItems(all, 'ak asiimov', 'all')).toEqual([])
  })

  // Seen live: "ft ak" listed StatTrak UMP-45s because "ak" sits inside "StatTrak".
  it('matches from the start of a word, not inside one', () => {
    const ump = item('StatTrak™ UMP-45 | Continuum (Field-Tested)')
    expect(ids(filterItems([...all, ump], 'ft ak', 'all'))).toEqual([redline.id])
    expect(ids(filterItems(all, 'vulc', 'all'))).toEqual([vulcan.id])
    expect(ids(filterItems(all, 'ak-47 red', 'all'))).toEqual([redline.id])
    expect(ids(filterItems(all, '47', 'all'))).toEqual([vulcan.id, redline.id])
    expect(filterItems(all, 'ulcan', 'all')).toEqual([])
    // Regex characters in the query are plain text.
    expect(ids(filterItems(all, '(foil', 'all'))).toEqual([redline.id])
    expect(filterItems(all, '.*', 'all')).toEqual([])
    expect(() => filterItems(all, '[', 'all')).not.toThrow()
  })

  it('matches wear by name or initials, rarity, StatTrak and attached stickers and charms', () => {
    expect(ids(filterItems(all, 'factory', 'all'))).toEqual([vulcan.id])
    expect(ids(filterItems(all, 'ft', 'all'))).toEqual([redline.id])
    expect(ids(filterItems(all, 'bs', 'all'))).toEqual([awp.id])
    expect(ids(filterItems(all, 'covert', 'all'))).toEqual([vulcan.id])
    expect(ids(filterItems(all, 'stattrak', 'all'))).toEqual([redline.id])
    expect(ids(filterItems(all, 'crown', 'all'))).toEqual([redline.id])
    expect(ids(filterItems(all, 'squirt', 'all'))).toEqual([redline.id])
  })

  it('filters by status', () => {
    expect(ids(filterItems(all, '', 'listed'))).toEqual([redline.id])
    expect(ids(filterItems(all, '', 'awaiting'))).toEqual([awp.id])
    expect(ids(filterItems(all, '', 'restricted'))).toEqual([case_.id])
    expect(ids(filterItems(all, '', 'sellable'))).toEqual([vulcan.id])
    expect(ids(filterItems(all, 'ak', 'sellable'))).toEqual([vulcan.id])
  })

  it('survives a malformed sticker payload', () => {
    const broken = item('Glock-18 | Fade', { own: { stickers: '{nope' } })
    expect(filterItems([broken], 'fade', 'all')).toEqual([broken])
  })
})
