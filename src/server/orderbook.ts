// Decodes the Steam Market orderbook that the React SSR listing page embeds.
//
// The classic listing page (Market_LoadOrderSpread globals) is gone; Steam now
// renders the market as a React SSR app. The listing page embeds the full order
// book inside `window.SSR.renderContext = JSON.parse("...")` as a react-query
// cache entry keyed ["market","orderbook",<appid>,"<hash>"], and no cheap
// endpoint exposes the item_nameid the classic itemordershistogram API needs.

export interface SsrOrderbook {
  amtMaxBuyOrder: number | null
  amtMinSellOrder: number | null
  eCurrency: number | null
  cBuyOrders: number | null
  cSellOrders: number | null
}

// The renderContext payload is a JSON string literal embedded in a JS string
// literal; each level is escaped once, so the raw slice must be un-escaped
// before JSON.parse. Handle \uXXXX escapes too (some control chars).
function jsUnescape(s: string): string {
  const esc: Record<string, string> = {
    n: '\n', t: '\t', r: '\r', b: '\b', f: '\f',
    '\\': '\\', '"': '"', "'": "'", '/': '/',
  }
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c !== '\\') {
      out += c
      continue
    }
    const n = s[i + 1]
    if (n === 'u') {
      out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16))
      i += 5
    } else if (n in esc) {
      out += esc[n]
      i += 1
    } else {
      out += n ?? ''
      i += 1
    }
  }
  return out
}

function num(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return v
}

export function decodeSsrOrderbook(
  html: string,
  hashName: string,
  appid = 730,
): SsrOrderbook | null {
  const marker = 'SSR.renderContext=JSON.parse("'
  const start = html.indexOf(marker)
  if (start === -1) return null
  const contentStart = start + marker.length
  const end = html.indexOf('")', contentStart)
  if (end === -1) return null
  let rc: { queryData?: string }
  try {
    rc = JSON.parse(jsUnescape(html.slice(contentStart, end))) as { queryData?: string }
  } catch {
    return null
  }
  if (typeof rc.queryData !== 'string') return null
  const cache = JSON.parse(rc.queryData) as {
    queries?: Array<{ queryKey?: unknown[]; state?: { data?: unknown } }>
  }
  for (const q of cache.queries ?? []) {
    const key = q.queryKey ?? []
    if (key[0] === 'market' && key[1] === 'orderbook' && key[2] === appid && key[3] === hashName) {
      const d = q.state?.data
      if (typeof d !== 'object' || d == null) return null
      return {
        amtMaxBuyOrder: num((d as Record<string, unknown>).amtMaxBuyOrder),
        amtMinSellOrder: num((d as Record<string, unknown>).amtMinSellOrder),
        eCurrency: num((d as Record<string, unknown>).eCurrency),
        cBuyOrders: num((d as Record<string, unknown>).cBuyOrders),
        cSellOrders: num((d as Record<string, unknown>).cSellOrders),
      }
    }
  }
  return null
}