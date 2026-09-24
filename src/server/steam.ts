import SteamCommunity from 'steamcommunity'
import type { CEconItem } from 'steamcommunity'
import { EAuthSessionGuardType, EAuthTokenPlatformType, LoginSession } from 'steam-session'
import type { StartSessionResponse } from 'steam-session/dist/interfaces-external'
import { clearSession, loadSession, saveSession, upsertItems } from './db'
import { decodeSsrOrderbook } from './orderbook'
import { attachedFromDescriptions, inspectFromProperties, type AssetPropertyEntry, type OwnItemFloat } from './floats'

export const APPID = 730
export const CONTEXTID = '2'
// Steam currency codes: 1 = USD, 3 = EUR. The account sells in EUR and the
// whole UI prices in euros, so query Steam in EUR by default.
export const CURRENCY_EUR = 3

const community = new SteamCommunity()

export type SessionProbeState = 'valid' | 'dead' | 'throttled' | 'unknown'

// TTL for a cached session-validity probe. The probe is a single cheap GET to
// https://steamcommunity.com/my (302 → profile when the session is valid, 302
// → /login when Steam rejected it, 4xx/5xx/network when the account/IP is
// throttled). It is also always re-run at the start of a sync, so this only
// sets how quickly a *silently rejected* session resolves on its own while the
// app idles.
const PROBE_TTL_MS = Number(process.env.SKINHQ_PROBE_TTL_MS ?? 10 * 60_000)
const PROBE_TIMEOUT_MS = 10_000

let sessionProbe: SessionProbeState = 'unknown'
let sessionProbeAt = 0
let probeInFlight: Promise<SessionProbeState> | null = null

// Classifies the community.loggedIn() callback (see the ambient declaration).
// Only a definitive rejection resolves to 'dead'; throttling and unexpected
// outcomes never clear a session.
export function classifyProbe(err: Error | null, loggedIn: boolean | null): SessionProbeState {
  if (!err) return loggedIn === true ? 'valid' : 'dead'
  if (/\b429\b/.test(err.message) || /HTTP error (400|5\d\d)/.test(err.message)) return 'throttled'
  return 'unknown'
}

function sessionProbeInfo(): { state: SessionProbeState; checkedAt: string | null } {
  return { state: sessionProbe, checkedAt: sessionProbeAt > 0 ? new Date(sessionProbeAt).toISOString() : null }
}

export function resetSessionProbe(): void {
  sessionProbe = 'unknown'
  sessionProbeAt = 0
}

function invalidateSession(reason: string): void {
  console.warn(`[steam] ${reason}; clearing stored session — sign in again`)
  clearSession()
  community.steamID = null
  sessionProbe = 'dead'
  sessionProbeAt = Date.now()
}

community.on('sessionExpired', () => {
  invalidateSession('Session expired on Steam side')
})

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('probe timed out')), ms)
    timer.unref()
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

function probeSessionOnce(): Promise<SessionProbeState> {
  return withTimeout(
    new Promise<SessionProbeState>((resolve) => {
      if (!community.steamID) {
        resolve('unknown')
        return
      }
      community.loggedIn((err, loggedIn) => resolve(classifyProbe(err, loggedIn)))
    }),
    PROBE_TIMEOUT_MS,
  )
}

async function runProbe(): Promise<SessionProbeState> {
  const state = await probeSessionOnce().catch(() => 'unknown' as SessionProbeState)
  sessionProbe = state
  sessionProbeAt = Date.now()
  if (state === 'dead' && community.steamID) invalidateSession('Steam rejected the stored session')
  return state
}

// Force a fresh session-validity probe: at the start of every sync, on boot
// with a restored session, and on sync failures that smell like a dead
// session. Deduplicated while one is in flight.
export function probeSessionNow(): Promise<SessionProbeState> {
  if (probeInFlight) return probeInFlight
  probeInFlight = runProbe().finally(() => {
    probeInFlight = null
  })
  return probeInFlight
}

// Rate-limit-friendly entry point for /api/auth/status: reuse the cached
// result until it goes stale, so status polling never hammers Steam.
export function ensureSessionProbe(): Promise<SessionProbeState> {
  if (!community.steamID) return Promise.resolve('unknown')
  if (probeInFlight) return probeInFlight
  if (Date.now() - sessionProbeAt < PROBE_TTL_MS) return Promise.resolve(sessionProbe)
  return probeSessionNow()
}

function scheduleProbe(delayMs: number): void {
  const timer = setTimeout(() => {
    void probeSessionNow()
  }, delayMs)
  timer.unref()
}

restoreSession()

function restoreSession(): void {
  const stored = loadSession()
  if (!stored) return
  try {
    community.setCookies(stored.cookies)
    console.info(`[steam] Restored stored session for ${stored.accountName}`)
    // A stored session may already have been silently rejected by Steam;
    // probe shortly after boot so the app lands in the right state on its own.
    scheduleProbe(5000)
  } catch (err) {
    console.warn('[steam] Stored session failed to restore, clearing', (err as Error).message)
    clearSession()
  }
}

export interface AuthStatus {
  loggedIn: boolean
  steamid: string | null
  accountName?: string | null
  pendingLogin?: LoginGuard | null
  session: { state: SessionProbeState; checkedAt: string | null }
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
    accountName: community.steamID ? (loadSession()?.accountName ?? null) : null,
    pendingLogin: pendingLogin?.guard ?? null,
    session: sessionProbeInfo(),
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
          // A freshly issued session is valid by construction.
          sessionProbe = 'valid'
          sessionProbeAt = Date.now()
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
  // steamcommunity@3.50.3 has no logOff(); clearing the stored cookies alone
  // leaves community.steamID set, so nothing reports the session as gone.
  community.steamID = null
  resetSessionProbe()
  return { loggedIn: false, steamid: null, session: sessionProbeInfo() }
}

function requireSession(): void {
  if (!community.steamID) throw new Error('Not logged in to Steam')
}

interface JsonResponse {
  status: number
  body: Record<string, unknown>
}

export function httpJson(method: 'get' | 'post', uri: string, extra: Record<string, unknown> = {}, retries = 3): Promise<JsonResponse> {
  return new Promise<JsonResponse>((resolve, reject) => {
    const attempt = (remaining: number, delay: number): void => {
      const options = { json: true, ...extra }
      const callback = (err: Error | null, response: { statusCode: number }, body: unknown) => {
        if (err) {
          // Steam throttles these endpoints; it reports pacing as explicit
          // 429s, or as a generic "HTTP error <status>" when the (empty)
          // body fails to parse — 400 and 500 are the common throttling
          // wrappers. Back off on all of them.
          if (remaining > 0 && (/\b429\b/.test(err.message) || /HTTP error (4\d\d|5\d\d)/.test(err.message))) {
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
  contextid: string
  name: string
  market_hash_name: string
  type: string
  icon_url: string
  tradable: boolean
  marketable: boolean
  marketable_restriction?: string
  pos: number
  tags?: Array<{ internal_name: string; name: string; category: string }>
  descriptions?: Array<{ type: string | number; value: string; color?: string }>
  own_float?: number
  own_seed?: number
  own_stickers?: string | null
}

function fetchContext(contextid: string): Promise<CEconItem[]> {
  const steamid = community.steamID as { getSteamID64(): string }
  return new Promise<CEconItem[]>((resolve, reject) => {
    community.getUserInventoryContents(steamid, APPID, contextid, false, 'english', (err, inv) => {
      if (err) { reject(err); return }
      resolve(inv)
    })
  })
}

function mapItem(item: CEconItem, contextid: string): InventoryItem {
  return {
    assetid: item.assetid,
    contextid,
    name: item.name ?? item.market_hash_name ?? 'Unknown',
    market_hash_name: item.market_hash_name ?? '',
    type: item.type ?? '',
    icon_url: item.icon_url ?? '',
    tradable: !!item.tradable,
    marketable: !!item.marketable,
    marketable_restriction: item.market_marketable_restriction,
    pos: item.pos,
    tags: (item.tags ?? []).map((t) => ({ internal_name: String(t.internal_name ?? ''), name: String(t.name ?? ''), category: String(t.category ?? '') })),
    descriptions: (item.descriptions ?? []).map((d) => ({ type: d.type, value: String(d.value ?? ''), color: d.color })),
  }
}

export async function getInventory(): Promise<{ items: InventoryItem[]; total: number }> {
  requireSession()
  const byId = new Map<string, InventoryItem>()

  const inv2 = await fetchContext(CONTEXTID)
  for (const item of inv2) byId.set(item.assetid, mapItem(item, CONTEXTID))

  try {
    // Context 16 (currently listed/on-market items) is an enhancement — a
    // transient failure here must not fail the whole inventory sync.
    const inv16 = await fetchContext('16')
    for (const item of inv16) if (!byId.has(item.assetid)) byId.set(item.assetid, mapItem(item, '16'))
  } catch (err) {
    console.warn('[inventory] context 16 (listed items) fetch failed, continuing with context 2 only:', (err as Error).message)
  }

  await attachOwnFloats(byId)

  const items = [...byId.values()]
  persistItems(items)
  return { items, total: items.length }
}

// The CS2 inventory JSON served to the page now exposes per-asset
// "asset_properties" with the self-encoded Item Certificate hex; decode it
// offline to get exact floats/seeds/stickers for owned items. A failure here
// must not fail the inventory sync — best-effort.
async function attachOwnFloats(byId: Map<string, InventoryItem>): Promise<void> {
  try {
    const props = await fetchOwnAssetProperties()
    for (const info of props.values()) {
      const item = byId.get(info.assetid)
      if (!item) continue
      attachNames(info, item.descriptions)
      item.own_float = info.float_value
      item.own_seed = info.paint_seed
      item.own_stickers =
        info.stickers.length > 0 || info.keychains.length > 0
          ? JSON.stringify({ stickers: info.stickers, keychains: info.keychains })
          : null
    }
  } catch (err) {
    console.warn('[inventory] own-item floats unavailable (best-effort):', (err as Error).message)
  }
}

// Steam's description blocks name applied stickers ("Sticker: ...") and the
// mounted charm ("Charm: ...") and carry their icon <img>; match them
// positionally onto the decoded sticker/keychain entries so the grid can
// render names/images offline.
function attachNames(info: OwnItemFloat, descriptions: InventoryItem['descriptions']): void {
  const { stickers, keychain } = attachedFromDescriptions(descriptions)
  info.stickers.forEach((s, i) => {
    const ref = stickers[i]
    s.name = ref?.name ?? null
    s.image = ref?.image ?? null
  })
  if (info.keychains.length > 0) {
    info.keychains[0].name = keychain?.name ?? null
    info.keychains[0].image = keychain?.image ?? null
  }
}

// Pages through the logged-in CS2 inventory JSON capturing asset_properties.
// Uses the cookie-jar transport (httpJson) so Steam rate-limits apply your
// session; sequential with a small delay between pages. Both the active
// (context 2) and listed (context 16) inventories are covered — fits a
// best-effort pass: a failure on one context still yields the other.
async function fetchOwnAssetProperties(): Promise<Map<string, OwnItemFloat>> {
  const result = new Map<string, OwnItemFloat>()
  const steamid = community.steamID as { getSteamID64(): string }
  for (const contextid of [CONTEXTID, '16']) {
    try {
      await collectContextProps(steamid.getSteamID64(), contextid, result)
    } catch (err) {
      console.warn(`[inventory] float properties unavailable for context ${contextid}:`, (err as Error).message)
    }
  }
  return result
}

async function collectContextProps(steamid64: string, contextid: string, into: Map<string, OwnItemFloat>): Promise<void> {
  // Steam's asset_properties endpoint is sessions-unfriendly: count=500 trips
  // its throttle (observed as HTTP 500) which then bleeds into the market
  // endpoints for that session. Use count=100 and pause between pages so
  // normal market access keeps working. Inventories over 100 assets must be
  // paged — a single request silently drops own-float/sticker/charm data for
  // the tail (e.g. StatTrak items sorted after the first 100).
  const base = `https://steamcommunity.com/inventory/${steamid64}/730/${contextid}?l=english`
  let startAssetid: string | undefined
  for (let page = 0; page < 50; page++) {
    const url = startAssetid ? `${base}&count=100&start_assetid=${startAssetid}` : `${base}&count=100`
    const resp = await httpJson('get', url)
    const { entries, next } = nextPropertiesPage(resp.body)
    for (const entry of entries) {
      const info = inspectFromProperties(entry)
      if (info) into.set(info.assetid, info)
    }
    if (!next || next === startAssetid) break
    startAssetid = next
    await sleep(700)
  }
  // Pause before the next context (context 2 then 16) as well.
  await sleep(700)
}

// Pure decoder for one page of the logged-in inventory JSON when it is being
// paged for asset_properties — extracted so the paging decision is
// unit-testable. Steam reports "there are more pages" as more_items=1|true
// with the next chunk anchored at more_start_assetid (legacy fallback:
// last_assetid). Returns the asset_properties entries plus the continuation
// token (or null when the page is terminal or the fetch failed).
export function nextPropertiesPage(body: Record<string, unknown>): {
  entries: AssetPropertyEntry[]
  next: string | null
} {
  if (body.success !== 1 && body.success !== true) return { entries: [], next: null }
  const entries = (body.asset_properties as AssetPropertyEntry[] | undefined) ?? []
  const more = body.more_items === true || body.more_items === 1
  if (!more) return { entries, next: null }
  const next =
    typeof body.more_start_assetid === 'string' && body.more_start_assetid
      ? body.more_start_assetid
      : typeof body.last_assetid === 'string' && body.last_assetid
        ? body.last_assetid
        : null
  return { entries, next }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function persistItems(items: InventoryItem[]): void {
  upsertItems(
    items.map((i) => ({
      assetid: i.assetid,
      appid: APPID,
      contextid: i.contextid ?? CONTEXTID,
      market_hash_name: i.market_hash_name,
      name: i.name,
      type: i.type,
      icon_url: i.icon_url,
      tradable: i.tradable ? 1 : 0,
      marketable: i.marketable ? 1 : 0,
      raw: JSON.stringify(i),
      own_float: i.own_float ?? null,
      own_seed: i.own_seed ?? null,
      own_stickers: i.own_stickers ?? null,
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
        contextid: CONTEXTID,
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
  median_cents: number | null
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

export async function priceOverview(hashName: string, currency = CURRENCY_EUR): Promise<SteamPriceOverview> {
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
    median_cents: body.median_price ? parsePriceToCents(body.median_price) : null,
    median_price: body.median_price ?? null,
    volume: body.volume ? parseInt(body.volume, 10) : null,
  }
}

export interface MarketOrderSpread {
  lowest_sell_cents: number | null
  sell_count: number | null
  highest_buy_cents: number | null
  buy_count: number | null
}

// Steam now renders the market as a React SSR app that embeds the full order
// book in its `renderContext` payload (see orderbook.ts), so fetch the listing
// page and decode that block instead of hunting item_nameid.
export async function marketOrderSpread(
  hashName: string,
  currency = CURRENCY_EUR,
  retries = 3,
): Promise<MarketOrderSpread> {
  const page = await fetchText(
    `https://steamcommunity.com/market/listings/${APPID}/${encodeURIComponent(hashName)}/`,
    { country: 'US', currency },
    retries,
  )
  const data = decodeSsrOrderbook(page, hashName, APPID)
  if (data == null) throw new Error(`no embedded orderbook for '${hashName}'`)
  if (data.eCurrency != null && data.eCurrency !== currency) {
    throw new Error(`orderbook currency mismatch for '${hashName}' (${data.eCurrency} != ${currency})`)
  }
  return {
    lowest_sell_cents: data.amtMinSellOrder ?? null,
    sell_count: data.cSellOrders ?? null,
    highest_buy_cents: data.amtMaxBuyOrder ?? null,
    buy_count: data.cBuyOrders ?? null,
  }
}

export interface SellResult {
  success: boolean
  needs_mobile_confirmation: boolean
  is_pending: boolean
  message?: string
}

export async function sellItem(assetid: string, priceCents: number, contextid = CONTEXTID): Promise<SellResult> {
  requireSession()
  const steamid = community.steamID as { getSteamID64(): string }
  const res = await httpJson('post', 'https://steamcommunity.com/market/sellitem/', {
    form: {
      sessionid: community.getSessionID(),
      appid: String(APPID),
      contextid,
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
  const pageSize = 100
  const MAX_PAGES = 20

  const fetchPage = async (start: number): Promise<{ total: number; rows: ListingRow[] }> => {
    let res = await httpJson('get', 'https://steamcommunity.com/market/mylistings/render/', {
      qs: { query: '', start, count: pageSize, norender: 1 },
    })
    if (res.status !== 200) {
      // Steam's mylistings endpoint can transiently return HTTP 400 (empty body)
      // when the account is being paced. One short retry, then a clear error.
      await sleep(3000)
      res = await httpJson('get', 'https://steamcommunity.com/market/mylistings/render/', {
        qs: { query: '', start, count: pageSize, norender: 1 },
      })
    }
    if (res.status !== 200) {
      throw new Error('Steam rejected the listings request (HTTP ' + res.status + ') — temporary, will retry next sync')
    }
    const body = res.body as {
      success?: number | boolean
      total_count?: number | string
      listings?: Record<string, Record<string, unknown>>
    }
    if (!(body.success === 1 || body.success === true)) {
      throw new Error('Failed to load your market listings')
    }
    const total =
      typeof body.total_count === 'string' ? parseInt(body.total_count, 10) : (body.total_count as number) ?? 0
    const rows = Object.values(body.listings ?? {}).map((l) => {
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
    return { total, rows }
  }

  const first = await fetchPage(0)
  const all: ListingRow[] = [...first.rows]
  let total = first.total
  // The endpoint reports a total_count that can exceed a single page; page
  // through until we've seen everything or hit the safety cap.
  while (total > all.length && all.length % pageSize === 0 && all.length / pageSize < MAX_PAGES) {
    const page = await fetchPage(all.length)
    if (page.rows.length === 0) break
    all.push(...page.rows)
    total = Math.max(total, page.total)
  }
  if (total > all.length) {
    console.warn(`[mylistings] truncated: ${total} active but only fetched ${all.length}`)
  }
  return { total, listings: all }
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