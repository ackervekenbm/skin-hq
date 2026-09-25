import { describe, expect, it } from 'vitest'
import { groupByRarity } from '../src/client/grouping'

interface TestItem {
  id: string
  rarity: { internal_name: string | null; name: string | null; rank: number } | null
}

const named = (id: string, internal_name: string, name: string, rank: number): TestItem => ({
  id,
  rarity: { internal_name, name, rank },
})

describe('groupByRarity', () => {
  it('returns an empty list for an empty input', () => {
    expect(groupByRarity<TestItem>([])).toEqual([])
  })

  it('buckets items without a rarity under unranked/Other at rank 99', () => {
    const withoutRarity: TestItem = { id: 'a', rarity: null }
    const groups = groupByRarity([withoutRarity])
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('unranked')
    expect(groups[0].label).toBe('Other')
    expect(groups[0].rank).toBe(99)
    expect(groups[0].items).toEqual([withoutRarity])
  })

  it('groups by internal_name and preserves insertion order within a group', () => {
    const items = [
      named('a', 'rare', 'Covert', 2),
      named('b', 'rare', 'Covert', 2),
      named('c', 'mil', 'Mil-Spec', 4),
    ]
    const groups = groupByRarity(items)
    expect(groups).toHaveLength(2)
    expect(groups[0].key).toBe('rare')
    expect(groups[0].label).toBe('Covert')
    expect(groups[0].items.map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('sorts groups ascending by rank', () => {
    const items = [
      named('a', 'high', 'Legendary', 1),
      named('b', 'low', 'Consumer', 9),
      named('c', 'mid', 'Restricted', 5),
    ]
    const groups = groupByRarity(items)
    expect(groups.map((g) => g.key)).toEqual(['high', 'mid', 'low'])
  })

  it('keeps different named groups with the same rank separate but stable', () => {
    const items = [named('a', 'x', 'X', 7), named('b', 'y', 'Y', 7)]
    const groups = groupByRarity(items)
    expect(groups.map((g) => g.key)).toEqual(['x', 'y'])
  })
})