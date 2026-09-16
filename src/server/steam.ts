import SteamCommunity from 'steamcommunity'
import type { CEconItem, CMarketItem } from 'steamcommunity'
import { EAuthSessionGuardType, EAuthTokenPlatformType, LoginSession } from 'steam-session'
import type { StartSessionResponse } from 'steam-session/dist/interfaces-external'
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
  pendingLogin?: LoginGuard | null
}

export type LoginGuard = 'approval' | 'email' | 'mobile'

export type LoginStep =
  | { status: 'ok'; loggedIn: true; steamid: string }
  | { status: 'awaiting'; guard: LoginGuard; emaildomain?: string }

interface PendingLogin {
  session: LoginSession
  accountName: string
  guard: LoginGuard | null
  completed: Promise<void>
}

const LOGIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'

let pendingLogin: PendingLogin | null = null

export function authStatus(): AuthStatus {
  return {
    loggedIn: !!community.steamID,
    steamid: community.steamID ? community.steamID.getSteamID64() : null,
    pendingLogin: pendingLogin?.guard ?? null,
  }
}

function clearPendingLogin(session: LoginSession): void {
  if (pendingLogin && pendingLogin.session === session) pendingLogin = null
}

function finishLogin(session: LoginSession, accountName: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    session.once('authenticated', () => {
      clearPendingLogin(session)
      void (async () => {
        try {
          const cookies = await session.getWebCookies()
          community.setCookies(cookies)
          const steamid = community.steamID ? community.steamID.getSteamID64() : ''
          saveSession({ accountName, steamid, cookies })
          resolve()
        } catch (err) {
          reject(err)
        }
      })()
    })
    session.once('timeout', () => {
      clearPendingLogin(session)
      reject(new Error('Login timed out — start again'))
    })
    session.once('error', (err: Error) => {
      clearPendingLogin(session)
      reject(err)
    })
  })
}

function waitForGuard(session: LoginSession, accountName: string, guard: LoginGuard, completed = finishLogin(session, accountName)): LoginStep {
  pendingLogin = { session, accountName, guard, completed }
  completed.catch(() => {})
  return { status: 'awaiting', guard }
}

export async function login(accountName: string, password: string): Promise<LoginStep> {
  if (pendingLogin) {
    try {
      pendingLogin.session.cancelLoginAttempt()
    } catch {
      /* already settled */
    }
    clearPendingLogin(pendingLogin.session)
  }

  const session = new LoginSession(EAuthTokenPlatformType.MobileApp, { userAgent: LOGIN_UA })
  session.on('error', () => {
    // Required sink; typed failures also surface through finishLogin's handler
  })

  const start: StartSessionResponse = await session.startWithCredentials({ accountName, password })

  if (!start.actionRequired) {
    await finishLogin(session, accountName)
    return { status: 'ok', loggedIn: true, steamid: community.steamID ? community.steamID.getSteamID64() : '' }
  }

  const valid = start.validActions ?? []
  const guardTypes = new Set(valid.map((a) => a.type))

  if (guardTypes.has(EAuthSessionGuardType.DeviceConfirmation) || guardTypes.has(EAuthSessionGuardType.EmailConfirmation)) {
    // Steam pushes a confirmation to the phone / email; poll until approved.
    return waitForGuard(session, accountName, 'approval')
  }

  const email = valid.find((a) => a.type === EAuthSessionGuardType.EmailCode)
  if (email) {
    waitForGuard(session, accountName, 'email')
    return { status: 'awaiting', guard: 'email', emaildomain: email.detail }
  }

  if (guardTypes.has(EAuthSessionGuardType.DeviceCode)) {
    return waitForGuard(session, accountName, 'mobile')
  }

  return waitForGuard(session, accountName, 'approval')
}

export async function submitGuardCode(code: string): Promise<AuthStatus> {
  if (!pendingLogin) throw new Error('No login in progress — sign in again')
  if (pendingLogin.guard === 'approval') throw new Error('Waiting for approval on your phone — no code needed')
  await pendingLogin.session.submitSteamGuardCode(code)
  await pendingLogin.completed
  return authStatus()
}

export function cancelPendingLogin(): void {
  if (pendingLogin) {
    try {
      pendingLogin.session.cancelLoginAttempt()
    } catch {
      /* noop */
    }
    clearPendingLogin(pendingLogin.session)
  }
}

export function logout(): AuthStatus {
  cancelPendingLogin()
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

function httpJson(method: 'get' | 'post', uri: string, extra: Record<string, unknown> = {}, retries = 3): Promise<JsonResponse> {
  return new Promise<JsonResponse>((resolve, reject) => {
    const attempt = (remaining: number, delay: number): void => {
      const options = { json: true, ...extra }
      const callback = (err: Error | null, response: { statusCode: number }, body: unknown) => {
        if (err) {
          if (remaining > 0 && /HTTP error 429/.test(err.message)) {
            setTimeout(() => attempt(remaining - 1, delay * 2), delay)
            return
          }
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
    }
    attempt(retries, 1000)
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

  persistItems(items)

  return { items, total }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function persistItems(items: InventoryItem[]): void {
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
}

const INVENTORY_PAGE_SIZE = 75

interface InventoryPage {
  assets: Array<{ assetid: string; classid: string; instanceid: string; amount: string }>
  descriptions: Array<{
    classid: string
    instanceid: string
    name?: string
    market_hash_name?: string
    type?: string
    icon_url?: string
    tradable?: boolean
    marketable?: boolean
    market_marketable_restriction?: number
  }>
  more_items?: boolean
  more_start_assetid?: string
}

export async function getPublicInventory(steamid: string): Promise<{ items: InventoryItem[]; total: number }> {
  if (!/^\d{17}$/.test(steamid)) throw new Error('Invalid steamid64')
  const items: InventoryItem[] = []
  let startAssetid: string | undefined
  for (let page = 0; page < 50; page++) {
    const qs: Record<string, unknown> = { l: 'english', count: INVENTORY_PAGE_SIZE }
    if (startAssetid) qs.start_assetid = startAssetid
    const text = await fetchText(`https://steamcommunity.com/inventory/${steamid}/${APPID}/${CONTEXTID}`, qs)
    const body = JSON.parse(text) as InventoryPage
    const descById = new Map<string, InventoryPage['descriptions'][number]>()
    for (const d of body.descriptions ?? []) descById.set(`${d.classid}_${d.instanceid}`, d)
    const pageItems: InventoryItem[] = (body.assets ?? []).map((a, i) => {
      const d = descById.get(`${a.classid}_${a.instanceid}`)
      return {
        assetid: a.assetid,
        name: d?.market_hash_name ?? d?.name ?? 'Unknown',
        market_hash_name: d?.market_hash_name ?? '',
        type: d?.type ?? '',
        icon_url: d?.icon_url ?? '',
        tradable: d?.tradable ?? false,
        marketable: d?.marketable ?? false,
        marketable_restriction: d?.market_marketable_restriction != null ? String(d.market_marketable_restriction) : undefined,
        pos: items.length + i,
      }
    })
    items.push(...pageItems)
    if (!body.more_items) break
    startAssetid = body.more_start_assetid
    await sleep(300)
  }
  persistItems(items)
  return { items, total: items.length }
}

export async function resolveSteamID64(input: string): Promise<string> {
  let ref = input.trim().replace(/\/+$/, '')
  ref = ref.replace(/^https?:\/\/steamcommunity\.com\//, '')
  const profiles = ref.match(/^profiles\/(\d{17})$/)
  if (profiles) return profiles[1]
  const vanity = ref.replace(/^id\//, '')
  if (/^\d{17}$/.test(vanity)) return vanity
  if (!vanity) throw new Error('Provide a Steam profile URL, custom URL, or steamid64')
  const xml = await fetchText(`https://steamcommunity.com/id/${encodeURIComponent(vanity)}/`, { xml: '1' })
  const m = xml.match(/<steamID64>(\d{17})<\/steamID64>/)
  if (!m) throw new Error(`Could not resolve Steam profile '${vanity}'`)
  return m[1]
}

export interface SteamPriceOverview {
  success: boolean
  lowest_cents: number | null
  lowest_price: string | null
  median_price: string | null
  volume: number | null
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'

async function fetchText(url: string, qs: Record<string, unknown> = {}, retries = 3): Promise<string> {
  const u = new URL(url)
  for (const [k, v] of Object.entries(qs)) {
    if (v != null) u.searchParams.set(k, String(v))
  }
  let lastErr: Error | null = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(u, { headers: { 'User-Agent': BROWSER_UA, Accept: '*/*' } })
    if (res.status === 429) {
      lastErr = new Error('HTTP error 429')
      await sleep(1000 * 2 ** attempt)
      continue
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  }
  throw lastErr ?? new Error('HTTP error 429')
}

export async function priceOverview(hashName: string, currency = 1): Promise<SteamPriceOverview> {
  const text = await fetchText('https://steamcommunity.com/market/priceoverview/', {
    appid: APPID,
    currency,
    market_hash_name: hashName,
    country: 'US',
  })
  const body = JSON.parse(text) as { success: number | boolean; lowest_price?: string; median_price?: string; volume?: string }
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
  const res = await httpJson('post', `https://steamcommunity.com/market/removelisting/${listingid}/`, {
    form: { sessionid: community.getSessionID() },
    headers: { Referer: 'https://steamcommunity.com/market/' },
  })
  return { success: res.status === 200 }
}

export interface ListingRow {
  listingid: string
  assetid?: string
  price_cents?: number
  name?: string
  market_hash_name?: string
  icon_url?: string
  tradable?: boolean
  marketable?: boolean
  marketable_restriction?: number
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
  const listings: ListingRow[] = Object.values(map).map((l) => {
    const asset = (l.asset as Record<string, unknown>) ?? {}
    return {
      listingid: String(l.listingid ?? ''),
      assetid: (l.assetid as string) ?? String(asset.id ?? ''),
      price_cents: typeof l.price === 'number' ? (l.price as number) : undefined,
      name: (asset.name as string) ?? undefined,
      market_hash_name: (asset.market_hash_name as string) ?? undefined,
      icon_url: (asset.icon_url as string) ?? undefined,
      tradable: asset.tradable != null ? asset.tradable === 1 : undefined,
      marketable: asset.marketable != null ? asset.marketable === 1 : undefined,
      marketable_restriction: asset.market_marketable_restriction as number | undefined,
    }
  })
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