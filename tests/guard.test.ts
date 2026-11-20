import { describe, expect, it } from 'vitest'
import { isAllowedHost, isCrossSiteWrite, isSteamId, parseAllowedHosts } from '../src/server/guard'

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

describe('isAllowedHost', () => {
  const none = parseAllowedHosts(undefined)

  it('answers to localhost and IP addresses, with or without a port', () => {
    for (const host of ['localhost', 'localhost:5173', '127.0.0.1:3000', '192.168.1.20:8090', '[::1]:3000', '[::1]']) {
      expect(isAllowedHost(host, none)).toBe(true)
    }
  })

  it('refuses any other name unless it is listed, so a rebound hostile name is refused', () => {
    expect(isAllowedHost('evil.example:8090', none)).toBe(false)
    expect(isAllowedHost('nas.local', none)).toBe(false)
    expect(isAllowedHost(undefined, none)).toBe(false)
    const listed = parseAllowedHosts(' Skins.Example.com , nas.local,')
    expect(isAllowedHost('skins.example.com', listed)).toBe(true)
    expect(isAllowedHost('NAS.local:8090', listed)).toBe(true)
    expect(isAllowedHost('evil.example', listed)).toBe(false)
    // A listed name's subdomain is a different name.
    expect(isAllowedHost('x.nas.local', listed)).toBe(false)
  })
})
