declare module 'steamcommunity' {
  import type { EventEmitter } from 'node:events'

  interface SteamID {
    getSteamID64(): string
    toString(): string
  }

  interface LoginDetails {
    accountName: string
    password: string
    twoFactorCode?: string
    disableMobile?: boolean
  }

  interface LoginErr extends Error {
    cause?: string
    steamguard?: boolean
    emailauth?: boolean
    twofactor?: boolean
  }

  interface CEconItem {
    assetid: string
    appid: number
    contextid: string
    classid: string
    instanceid: string
    market_hash_name?: string
    name?: string
    icon_url?: string
    icon_url_large?: string
    tradable?: boolean | number
    marketable?: boolean | number
    commodity?: boolean | number
    market_tradable_restriction?: string
    market_marketable_restriction?: string
    type?: string
    pos: number
    tags?: Array<{ internal_name: string; name: string; category: string }>
    descriptions?: Array<{ type: string | number; value: string; color?: string }>
  }

  interface CMarketItem {
    commodity: boolean
    commodityID: number
    medianSalePrices: { hour: Date; price: number; quantity: number }[] | null
    quantity: number
    buyQuantity: number
    lowestPrice: number
    highestBuyOrder: number
    firstAsset: CEconItem | null
    assets: Record<string, CEconItem> | null
  }

  interface MarketItemCallback {
    (err: Error | null, item: CMarketItem): void
  }

  interface HttpOptions {
    uri?: string
    url?: string
    method?: string
    json?: boolean
    form?: Record<string, string>
    qs?: Record<string, string | number>
    headers?: Record<string, string>
    checkHttpError?: boolean
    checkCommunityError?: boolean
    checkTradeError?: boolean
    checkJsonError?: boolean
  }

  interface HttpCallback {
    (err: Error | null, response: { statusCode: number; headers: Record<string, string> }, body: unknown): void
  }

  class SteamCommunityClass extends EventEmitter {
    constructor(options?: { userAgent?: string; localAddress?: string; request?: unknown })
    steamID: SteamID | null
    login(details: LoginDetails, callback: (err: LoginErr | null, sessionID?: string, cookies?: string[], steamguard?: string, mobileAccessToken?: string) => void): void
    setCookies(cookies: string[]): void
    getSessionID(host?: string): string
    getUserInventoryContents(
      userID: string | SteamID,
      appID: number,
      contextID: number | string,
      tradableOnly: boolean,
      callback: (err: Error | null, inventory: CEconItem[], currencies: unknown[], totalCount: number) => void,
    ): void
    getUserInventoryContents(
      userID: string | SteamID,
      appID: number,
      contextID: number | string,
      tradableOnly: boolean,
      language: string,
      callback: (err: Error | null, inventory: CEconItem[], currencies: unknown[], totalCount: number) => void,
    ): void
    getMarketItem(appid: number, hashName: string, callback: MarketItemCallback): void
    getMarketItem(appid: number, hashName: string, currency: number, callback: MarketItemCallback): void
    httpRequest(uri: string | HttpOptions, options: HttpOptions, callback: HttpCallback, source?: string): void
    httpRequest(uri: string, callback: HttpCallback): void
    httpRequestGet(uri: string, options: HttpOptions, callback: HttpCallback, source?: string): void
    httpRequestGet(uri: string, callback: HttpCallback): void
    httpRequestPost(uri: string, options: HttpOptions, callback: HttpCallback, source?: string): void
    httpRequestPost(uri: string, callback: HttpCallback): void
    on(event: 'sessionExpired', listener: (err: Error) => void): this
    on(event: string | symbol, listener: (...args: unknown[]) => void): this
  }

  export type { CEconItem, CMarketItem, SteamID }
  const SteamCommunity: new (options?: { userAgent?: string; localAddress?: string; request?: unknown }) => SteamCommunityClass
  export default SteamCommunity
}