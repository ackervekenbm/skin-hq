import { describe, expect, it } from 'vitest'
import { decodeSsrOrderbook } from '../src/server/orderbook'

const HASH = '★ Skeleton Knife | Doppler (Factory New)'

// Rebuild the page shape Steam serves: the react-query cache is a JSON string
// held inside `renderContext`, a JSON object embedded verbatim in a JS string
// literal (`window.SSR.renderContext = JSON.parse("...")`).
function pageFor(hash: string, data: unknown, appid = 730): string {
  const cache = {
    queries: [
      {
        queryKey: ['market', 'orderbook', appid, hash],
        state: { status: 'success', data },
      },
    ],
  }
  const rc = { localizationSettings: { languages: [] }, queryData: JSON.stringify(cache) }
  const embedded = JSON.stringify(rc).replaceAll('"', '\\"')
  return [
    '<!doctype html><html><head>',
    '<script>window.__something = 1;</script>',
    `<script>window.SSR=${JSON.stringify({ loaderData: [] })};window.SSR.renderContext=JSON.parse("${embedded}");</script>`,
    '</head><body></body></html>',
  ].join('')
}

describe('decodeSsrOrderbook', () => {
  it('extracts the order book for the matching hash', () => {
    const html = pageFor(HASH, {
      amtMaxBuyOrder: 65125,
      amtMinSellOrder: 66450,
      eCurrency: 3,
      cBuyOrders: 856,
      cSellOrders: 73,
      rgCompactBuyOrders: [65125, 1],
      rgCompactSellOrders: [66450, 1],
    })
    expect(decodeSsrOrderbook(html, HASH)).toEqual({
      amtMaxBuyOrder: 65125,
      amtMinSellOrder: 66450,
      eCurrency: 3,
      cBuyOrders: 856,
      cSellOrders: 73,
    })
  })

  it('matches non-ASCII hash names (★, ™, pipe, parens)', () => {
    const hash = '★ StatTrak™ AWP | Atheris (Field-Tested)'
    const html = pageFor(hash, { amtMaxBuyOrder: 100, amtMinSellOrder: 200, eCurrency: 3, cBuyOrders: 1, cSellOrders: 2 })
    expect(decodeSsrOrderbook(html, hash)?.amtMinSellOrder).toBe(200)
  })

  it('returns null when another appid is requested', () => {
    const html = pageFor(HASH, { amtMaxBuyOrder: 5, amtMinSellOrder: 6, eCurrency: 3, cBuyOrders: 0, cSellOrders: 0 })
    expect(decodeSsrOrderbook(html, HASH, 440)).toBeNull()
  })

  it('returns null when the hash has no orderbook entry', () => {
    const html = pageFor('Some Other Hash', { amtMaxBuyOrder: 5, amtMinSellOrder: 6, eCurrency: 3, cBuyOrders: 0, cSellOrders: 0 })
    expect(decodeSsrOrderbook(html, HASH)).toBeNull()
  })

  it('returns null when the page has no renderContext block', () => {
    expect(decodeSsrOrderbook('<html><body>no data</body></html>', HASH)).toBeNull()
  })

  it('returns null on corrupted embedded JSON', () => {
    const html = '<script>window.SSR.renderContext=JSON.parse("{\\"broken' + '</script>'
    expect(decodeSsrOrderbook(html, HASH)).toBeNull()
  })
})