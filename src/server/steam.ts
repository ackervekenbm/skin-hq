import SteamCommunity from 'steamcommunity'
import type { CEconItem, CMarketItem } from 'steamcommunity'
import { clearSession, loadSession, saveSession, upsertItems } from './db'

export const APPID = 730
export const CONTEXTID = '2'

const community = new SteamCommunity()

community.on('sessionExpired', () => {
  console.warn('[steam] Session expired on Steam side; clearing stored session')
  clearSession()
})

restoreSession()

function restoreSession(): void {
  const stored = loadSession()
  if (!stored) return
  try {
    community.setCookies(stored.cookies)
    console.info(`[steam] Restored stored session for ${stored.accountName}`)
  } catch (err) {
    console.warn('[steam] Stored session failed to restore, clearing', (err as Error).message)
    clearSession()
  }
}

export interface AuthStatus {
  loggedIn: boolean
  steamid: string | null
}

export function authStatus(): AuthStatus {
  return { loggedIn: !!community.steamID, steamid: community.steamID ? community.steamID.getSteamID64() : null }
}

export async function login(accountName: string, password: string, twoFactorCode?: string): Promise<AuthStatus> {
  let cookies: string[] = []
  if (!community.steamID) {
    cookies = await new Promise<string[]>((resolve, reject) => {
      community.login({ accountName, password, twoFactorCode, disableMobile: true }, (err, _sid, gotCookies) => {
        if (err) {
          reject(new Error(err.message || 'Steam login failed'))
          return
        }
        resolve(gotCookies ?? [])
      })
    })
  }
  saveSession({ accountName, steamid: community.steamID ? community.steamID.getSteamID64() : '', cookies })
  return authStatus()
}

export function logout(): AuthStatus {
  clearSession()
  return { loggedIn: false, steamid: null }
}

function requireSession(): void {
  if (!community.steamID) throw new Error('Not logged in to Steam')
}

interface JsonResponse {
  status: number
  body: Record<string, unknown>
}

function httpJson(method: 'get' | 'post', uri: string, extra: Record<string, unknown> = {}): Promise<JsonResponse> {
  return new Promise<JsonResponse>((resolve, reject) => {
    const options = { json: true, ...extra }
    const callback = (err: Error | null, response: { statusCode: number }, body: unknown) => {
      if (err) {
        reject(err)
        return
      }
      resolve({ status: response.statusCode, body: body as Record<string, unknown> })
    }
    if (method === 'get') {
      community.httpRequestGet(uri, options, callback, 'skin-hq')
    } else {
      community.httpRequestPost(uri, options, callback, 'skin-hq')
    }
  })
}

export interface InventoryItem {
  assetid: string
  name: string
  market_hash_name: string
  type: string
  icon_url: string
  tradable: boolean
  marketable: boolean
  marketable_restriction?: string
  pos: number
}

export async function getInventory(): Promise<{ items: InventoryItem[]; total: number }> {
  requireSession()
  const steamid = community.steamID as { getSteamID64(): string }
  const [inventory, , total] = await new Promise<[CEconItem[], unknown[], number]>((resolve, reject) => {
    community.getUserInventoryContents(steamid, APPID, CONTEXTID, false, 'english', (err, inv, currencies, count) => {
      if (err) {
        reject(err)
        return
      }
      resolve([inv, currencies, count])
    })
  })

  const items: InventoryItem[] = inventory.map((item) => ({
    assetid: item.assetid,
    name: item.name ?? item.market_hash_name ?? 'Unknown',
    market_hash_name: item.market_hash_name ?? '',
    type: item.type ?? '',
    icon_url: item.icon_url ?? '',
    tradable: !!item.tradable,
    marketable: !!item.marketable,
    marketable_restriction: item.market_marketable_restriction,
    pos: item.pos,
  }))

  upsertItems(
    items.map((i) => ({
      assetid: i.assetid,
      appid: APPID,
      contextid: CONTEXTID,
      market_hash_name: i.market_hash_name,
      name: i.name,
      type: i.type,
      icon_url: i.icon_url,
      tradable: i.tradable ? 1 : 0,
      marketable: i.marketable ? 1 : 0,
      raw: JSON.stringify(i),
      updated_at: new Date().toISOString(),
    })),
  )

  return { items, total }
}

export interface SteamPriceOverview {
  success: boolean
  lowest_cents: number | null
  lowest_price: string | null
  median_price: string | null
  volume: number | null
}

export async function priceOverview(hashName: string, currency = 1): Promise<SteamPriceOverview> {
  const res = await httpJson('get', 'https://steamcommunity.com/market/priceoverview/', {
    qs: { appid: APPID, currency, market_hash_name: hashName, country: 'US' },
  })
  const body = res.body as { success: number | boolean; lowest_price?: string; median_price?: string; volume?: string }
  return {
    success: body.success === 1 || body.success === true,
    lowest_cents: body.lowest_price ? parsePriceToCents(body.lowest_price) : null,
    lowest_price: body.lowest_price ?? null,
    median_price: body.median_price ?? null,
    volume: body.volume ? parseInt(body.volume, 10) : null,
  }
}

export interface MarketItem {
  commodity: boolean
  commodityID: number
  lowest_cents: number
  highest_buy_cents: number
  quantity: number
  buy_quantity: number
}

export function marketItemDetail(hashName: string, currency = 1): Promise<MarketItem> {
  return new Promise<MarketItem>((resolve, reject) => {
    community.getMarketItem(APPID, hashName, currency, (err, item: CMarketItem) => {
      if (err) {
        reject(err)
        return
      }
      resolve({
        commodity: item.commodity,
        commodityID: item.commodityID,
        lowest_cents: item.lowestPrice,
        highest_buy_cents: item.highestBuyOrder,
        quantity: item.quantity,
        buy_quantity: item.buyQuantity,
      })
    })
  })
}

export interface SellResult {
  success: boolean
  needs_mobile_confirmation: boolean
  is_pending: boolean
  message?: string
}

export async function sellItem(assetid: string, priceCents: number): Promise<SellResult> {
  requireSession()
  const steamid = community.steamID as { getSteamID64(): string }
  const res = await httpJson('post', 'https://steamcommunity.com/market/sellitem/', {
    form: {
      sessionid: community.getSessionID(),
      appid: String(APPID),
      contextid: CONTEXTID,
      assetid,
      amount: '1',
      price: String(priceCents),
    },
    headers: { Referer: `https://steamcommunity.com/profiles/${steamid.getSteamID64()}/inventory` },
  })
  const body = res.body as { success?: number | boolean; needs_mobile_confirmation?: boolean; message?: string }
  return {
    success: body.success === 1 || body.success === true,
    needs_mobile_confirmation: !!body.needs_mobile_confirmation,
    is_pending: !!body.message?.toLowerCase().includes('pending confirmation'),
    message: body.message,
  }
}

export async function cancelListing(listingid: string): Promise<{ success: boolean }> {
  requireSession()
  const res = await httpJson('post', `https://steamcommunity.com/market/removelisting/${listingid}`, {
    form: { sessionid: community.getSessionID() },
  })
  return { success: (res.body as { success?: number | boolean }).success === 1 }
}

export interface ListingRow {
  listingid: string
  assetid?: string
  price_cents?: number
}

export async function getMyListings(): Promise<{ total: number; listings: ListingRow[] }> {
  requireSession()
  const res = await httpJson('get', 'https://steamcommunity.com/market/mylistings/render/', {
    qs: { query: '', start: 0, count: 100, norender: 1 },
  })
  const body = res.body as {
    success?: number | boolean
    total_count?: number | string
    listings?: Record<string, Record<string, unknown>>
  }
  if (!(body.success === 1 || body.success === true)) {
    throw new Error('Failed to load your market listings')
  }
  const map = body.listings ?? {}
  const listings: ListingRow[] = Object.values(map).map((l) => ({
    listingid: String(l.listingid ?? ''),
    assetid: (l.assetid as string) ?? undefined,
    price_cents: typeof l.price === 'number' ? (l.price as number) : undefined,
  }))
  return {
    total: typeof body.total_count === 'string' ? parseInt(body.total_count, 10) : (body.total_count as number) ?? listings.length,
    listings,
  }
}

export function parsePriceToCents(text: string): number | null {
  const digits = text.replace(/[^0-9.,]/g, '')
  if (!digits) return null

  let decimalSep: string | null = null
  const dotIdx = digits.lastIndexOf('.')
  const commaIdx = digits.lastIndexOf(',')
  if (dotIdx !== -1 && commaIdx !== -1) {
    decimalSep = dotIdx > commaIdx ? '.' : ','
  } else if (dotIdx !== -1) {
    decimalSep = /\.\d{1,2}$/.test(digits) ? '.' : null
  } else if (commaIdx !== -1) {
    decimalSep = /,\d{1,2}$/.test(digits) ? ',' : null
  }

  const cleaned =
    decimalSep === ',' ? digits.replace(/\./g, '').replace(',', '.') : decimalSep === '.' ? digits.replace(/,/g, '') : digits
  const amount = Number(cleaned)
  if (!Number.isFinite(amount) || amount <= 0) return null
  return Math.round(amount * 100)
}