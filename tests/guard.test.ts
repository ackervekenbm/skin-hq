import { describe, expect, it } from 'vitest'
import { isCrossSiteWrite, isSteamId } from '../src/server/guard'

const headers = (h: Record<string, string>) => (name: string) => h[name]

describe('isCrossSiteWrite', () => {
  it('lets reads through whatever the headers say', () => {
    expect(isCrossSiteWrite('GET', headers({ 'sec-fetch-site': 'cross-site' }))).toBe(false)
  })

  it('lets the app itself write: same-origin JSON', () => {
    expect(isCrossSiteWrite('POST', headers({ 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }))).toBe(false)
    // curl and older browsers send no Sec-Fetch-Site.
    expect(isCrossSiteWrite('POST', headers({ 'content-type': 'application/json; charset=utf-8' }))).toBe(false)
  })

  it('refuses writes from another site, including another port on the same host', () => {
    for (const site of ['cross-site', 'same-site']) {
      expect(isCrossSiteWrite('POST', headers({ 'sec-fetch-site': site, 'content-type': 'application/json' }))).toBe(true)
    }
  })

  it('refuses writes that are not JSON, which is all a cross-site form can send', () => {
    expect(isCrossSiteWrite('POST', headers({}))).toBe(true)
    expect(isCrossSiteWrite('POST', headers({ 'content-type': 'text/plain' }))).toBe(true)
    expect(isCrossSiteWrite('POST', headers({ 'content-type': 'application/x-www-form-urlencoded' }))).toBe(true)
  })
})

describe('isSteamId', () => {
  it('accepts digit-only ids and nothing else', () => {
    expect(isSteamId('7612345678901234567')).toBe(true)
    expect(isSteamId('16')).toBe(true)
    for (const bad of ['', '12/../x', '12a', ' 12', 12, null, undefined, '1'.repeat(21)]) expect(isSteamId(bad)).toBe(false)
  })
})
