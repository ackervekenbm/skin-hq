import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  baseName,
  eurosToCents,
  formatAmount,
  formatAutoSyncMin,
  formatEuro,
  formatFloat,
  formatGridPrice,
  isStatTrak,
  parseStickers,
  relTime,
  wearOf,
  type GridPrice,
  type StickerRef,
} from './format'
import { groupByRarity, type RarityGroup } from './grouping'

interface AuthStatus {
  loggedIn: boolean
  steamid: string | null
  accountName?: string | null
  pendingLogin?: 'approval' | 'email' | 'mobile' | null
  session?: { state: 'valid' | 'dead' | 'throttled' | 'unknown'; checkedAt: string | null }
}

type LoginResponse =
  | { loggedIn: true; steamid: string }
  | { needsApproval: true }
  | { needsCode: true; guard: 'email' | 'mobile'; emaildomain?: string }

interface GridItem {
  assetid: string
  contextid: string
  name: string
  market_hash_name: string
  icon_url: string
  marketable: boolean
  marketable_restriction?: string | null
  rarity: { internal_name: string | null; name: string | null; rank: number } | null
  own: { float_value: number; paint_seed: number; stickers: string | null } | null
  prices: Record<string, GridPrice>
  listing: { listingid: string; price_cents: number | null } | null
  pricesSyncedAt: string | null
}

interface SyncStatus {
  running: boolean
  startedAt: string | null
  phase: 'idle' | 'inventory' | 'listings' | 'prices'
  current: number
  total: number
  last: { inventory: string | null; listings: string | null; prices: string | null }
  errors: string[]
  blockMessage?: string | null
  completedRuns?: number
  autoSyncMin?: number | null
}

interface GridResponse {
  refreshedAt: string | null
  counts: { inventory: number; marketable: number; listed: number }
  sync: SyncStatus
  items: GridItem[]
}

interface CompareSide {
  provider: 'steam' | 'csfloat'
  currency: 'EUR' | 'USD'
  lowest_cents: number | null
  net_cents: number | null
  volume: number | null
  sell_count: number | null
  buy_count: number | null
  highest_buy_cents: number | null
  float_value: number | null
  paint_seed: number | null
  stickers: StickerRef[] | null
  error?: string
  fetched_at: string | null
}

interface CompareRow {
  hash: string
  name: string
  icon_url: string
  listed: boolean
  listing_price_cents: number | null
  steam: CompareSide
  csfloat: CompareSide | null
  netUsd: { steam: number | null; csfloat: number | null }
  deltaPercent: number | null
  bestVenue: 'steam' | 'csfloat' | null
}

interface LogLine {
  kind: 'ok' | 'warn' | 'err'
  text: string
}

const THEMES = [
  { id: 'onyx', label: 'Onyx', bg: '#0b0d10', accent: '#b9e233' },
  { id: 'dusk', label: 'Dusk', bg: '#0d0b1a', accent: '#8b7bff' },
  { id: 'ember', label: 'Ember', bg: '#151009', accent: '#ffb454' },
  { id: 'blue', label: 'Blue', bg: '#0a0e1c', accent: '#5b8cff' },
] as const

type ThemeId = (typeof THEMES)[number]['id']

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body
}

export default function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [accountName, setAccountName] = useState('')
  const [password, setPassword] = useState('')
  const [twoFactorCode, setTwoFactorCode] = useState('')
  const [needsCode, setNeedsCode] = useState<'email' | 'mobile' | null>(null)
  const [pendingApproval, setPendingApproval] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [grid, setGrid] = useState<GridResponse | null>(null)
  const [gridLoading, setGridLoading] = useState(false)
  const [grouping, setGrouping] = useState(true)
  const [listedOnly, setListedOnly] = useState(false)
  const [sellPrices, setSellPrices] = useState<Record<string, string>>({})
  const [compare, setCompare] = useState<CompareRow | null>(null)
  const [compareLoading, setCompareLoading] = useState(false)
  const [detail, setDetail] = useState<GridItem | null>(null)
  const [dockOpen, setDockOpen] = useState(false)
  const [dismissedErrors, setDismissedErrors] = useState<string[]>([])
  const [sellingIds, setSellingIds] = useState<string[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [theme, setTheme] = useState<ThemeId>(() => {
    let saved: string | null = null
    try {
      saved = typeof localStorage !== 'undefined' ? localStorage.getItem('skin-hq-theme') : null
    } catch {
      /* storage unavailable — fall back to default */
    }
    return THEMES.some((t) => t.id === saved) ? (saved as ThemeId) : 'onyx'
  })
  const [log, setLog] = useState<LogLine[]>([])
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [syncWatching, setSyncWatching] = useState(false)

  const pushLog = useCallback((kind: LogLine['kind'], text: string) => {
    setLog((prev) => [...prev.slice(-30), { kind, text }])
  }, [])

  const fetchStatus = useCallback(async (): Promise<AuthStatus | null> => {
    try {
      return await api<AuthStatus>('/api/auth/status')
    } catch (err) {
      pushLog('err', `status: ${(err as Error).message}`)
      return null
    }
  }, [pushLog])

  useEffect(() => {
    const timer = setTimeout(() => {
      void fetchStatus().then(setStatus)
    }, 0)
    return () => clearTimeout(timer)
  }, [fetchStatus])

  // Slow cadence while the app is open: a silently-rejected Steam session
  // flips us to logged-out on its own, no reload or manual action needed. The
  // server only re-probes when its cached result is stale, so this never
  // hammers Steam.
  useEffect(() => {
    const timer = setInterval(() => {
      void fetchStatus().then(setStatus)
    }, 30_000)
    return () => clearInterval(timer)
  }, [fetchStatus])

  // Surface the moment Steam drops a session we previously had, instead of
  // just quietly showing the sign-in form.
  const prevLoggedIn = useRef<boolean | null>(null)
  useEffect(() => {
    if (status) {
      if (prevLoggedIn.current === true && !status.loggedIn) {
        pushLog('err', 'Steam session expired — sign in again')
      }
      prevLoggedIn.current = status.loggedIn
    }
  }, [status, pushLog])

  async function kickSyncAfterLogin() {
    try {
      await api('/api/sync', { method: 'POST' })
    } catch (err) {
      pushLog('err', `sync: ${(err as Error).message}`)
    }
  }

  async function doLogin() {
    setLoginError(null)
    try {
      const res = await api<LoginResponse>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ accountName, password }),
      })
      if ('needsApproval' in res) {
        setNeedsCode(null)
        setPendingApproval(true)
        pushLog('warn', 'Approve this sign-in in your Steam Mobile app — waiting…')
        void pollApproval()
        return
      }
      if ('needsCode' in res) {
        setNeedsCode(res.guard)
        setPendingApproval(false)
        if (res.guard === 'email') {
          pushLog('warn', 'Steam Guard email with a code was sent — check your inbox and enter the code below.')
        } else {
          pushLog('warn', 'Enter the current code from your Steam Mobile app below.')
        }
        return
      }
      setNeedsCode(null)
      setPendingApproval(false)
      setPassword('')
      setTwoFactorCode('')
      setStatus({ loggedIn: true, steamid: res.steamid })
      void kickSyncAfterLogin()
      pushLog('ok', `Logged in as ${accountName}`)
    } catch (err) {
      setPendingApproval(false)
      setLoginError((err as Error).message)
      pushLog('err', `login: ${(err as Error).message}`)
    }
  }

  async function pollApproval() {
    for (let i = 0; i < 150; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      try {
        const s = await api<AuthStatus>('/api/auth/status')
        if (s.loggedIn) {
          setPendingApproval(false)
          setNeedsCode(null)
          setPassword('')
          setTwoFactorCode('')
          setStatus({ loggedIn: true, steamid: s.steamid })
          void kickSyncAfterLogin()
          pushLog('ok', 'Approved in Steam Mobile — signed in')
          return
        }
        if (!s.pendingLogin) {
          setPendingApproval(false)
          pushLog('err', 'Login ended — sign in again')
          return
        }
      } catch (err) {
        pushLog('err', `status: ${(err as Error).message}`)
      }
    }
    setPendingApproval(false)
    pushLog('err', 'Timed out waiting for approval')
  }

  async function submitCode() {
    setLoginError(null)
    try {
      const s = await api<AuthStatus>('/api/auth/guard', {
        method: 'POST',
        body: JSON.stringify({ code: twoFactorCode.trim() }),
      })
      setNeedsCode(null)
      setTwoFactorCode('')
      setPassword('')
      setStatus(s)
      void kickSyncAfterLogin()
      pushLog('ok', 'Signed in to Steam')
    } catch (err) {
      setLoginError((err as Error).message)
      pushLog('err', `code: ${(err as Error).message}`)
    }
  }

  async function doLogout(): Promise<boolean> {
    try {
      await api('/api/auth/logout', { method: 'POST' })
    } catch (err) {
      pushLog('err', `logout: ${(err as Error).message}`)
      return false
    }
    setStatus({ loggedIn: false, steamid: null })
    setNeedsCode(null)
    setPendingApproval(false)
    setPassword('')
    setTwoFactorCode('')
    setLoginError(null)
    setGrid(null)
    setDetail(null)
    setCompare(null)
    setDismissedErrors([])
    setSellingIds([])
    pushLog('ok', 'Logged out')
    return true
  }

  const refreshGrid = useCallback(async () => {
    let g: GridResponse | null = null
    try {
      g = await api<GridResponse>('/api/grid')
      setGrid(g)
    } catch (err) {
      pushLog('err', `grid: ${(err as Error).message}`)
    }
    return g
  }, [pushLog])

  const loadGrid = useCallback(async () => {
    const g = await refreshGrid()
    if (g) {
      setSyncStatus(null)
      lastRunCount.current = g.sync.completedRuns ?? null
    }
  }, [refreshGrid])

  const loadCompare = useCallback(
    async (hash: string) => {
      setCompareLoading(true)
      try {
        const r = await api<{ compare: CompareRow | null }>(`/api/compare?hash=${encodeURIComponent(hash)}`)
        setCompare(r.compare)
      } catch (err) {
        pushLog('err', `compare: ${(err as Error).message}`)
      } finally {
        setCompareLoading(false)
      }
    },
    [pushLog],
  )

  function openDetail(item: GridItem) {
    setCompare(null)
    setDetail(item)
    void loadCompare(item.market_hash_name)
  }

  const closeDetail = useCallback(() => {
    setDetail(null)
    setCompare(null)
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('skin-hq-theme', theme)
  }, [theme])

  useEffect(() => {
    if (!detail && !settingsOpen) return undefined
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeDetail()
        setSettingsOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detail, settingsOpen, closeDetail])

  async function syncNow() {
    if (!status?.loggedIn) {
      pushLog('err', 'sync: sign in to Steam first')
      return
    }
    setGridLoading(true)
    try {
      const r = await api<{ started: boolean; sync: SyncStatus }>('/api/sync', { method: 'POST' })
      if (!r.started) {
        pushLog('warn', r.sync.blockMessage ?? 'Sync already running')
        setGridLoading(false)
        return
      }
      pushLog('ok', 'Sync started — inventory, listings, prices')
    } catch (err) {
      pushLog('err', `sync: ${(err as Error).message}`)
      setGridLoading(false)
      return
    }
    setSyncWatching(true)
  }

  // Auto-refresh the sync status while a sync is running and re-pull the grid
  // when it finishes, so prices show up without manual reloads.
  useEffect(() => {
    if (!syncWatching && !(grid?.sync.running ?? false)) return
    let cancelled = false
    const tick = async () => {
      try {
        const s = await api<SyncStatus>('/api/sync/status')
        if (cancelled) return
        setSyncStatus(s)
        if (!s.running) {
          setSyncWatching(false)
          await loadGrid()
          setGridLoading(false)
          pushLog('ok', 'Sync finished')
        } else {
          await refreshGrid()
        }
      } catch (err) {
        pushLog('err', `sync status: ${(err as Error).message}`)
      }
    }
    void tick()
    const timer = setInterval(tick, 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [syncWatching, grid?.sync.running, loadGrid, refreshGrid, pushLog])

  const syncDisplay = syncStatus ?? grid?.sync ?? null

  // Auto-sync visibility: the server runs scheduled syncs this tab didn't
  // start. Poll /api/sync/status and surface progress + refresh the grid when
  // an un-watched run finishes, so "prices synced" timestamps move on their
  // own on an always-on box.
  const lastRunCount = useRef<number | null>(null)
  useEffect(() => {
    if (!status?.loggedIn || syncWatching) return undefined
    let cancelled = false
    const tick = async () => {
      try {
        const s = await api<SyncStatus>('/api/sync/status')
        if (cancelled) return
        if (s.running) {
          setSyncStatus(s)
          await refreshGrid()
        } else if (s.completedRuns != null && lastRunCount.current != null) {
          if (s.completedRuns > lastRunCount.current) {
            // A run finished while we weren't watching it — refresh the grid.
            // loadGrid() re-anchors lastRunCount from the fresh grid, so a
            // failed reload leaves the ref untouched and the next tick retries.
            setSyncStatus(null)
            await loadGrid()
            if (lastRunCount.current === s.completedRuns) pushLog('ok', 'Auto-sync finished')
          } else if (s.completedRuns < lastRunCount.current) {
            // The server restarted (in-memory counter reset): clear any stale
            // progress state and reload so timestamps match the live server.
            setSyncStatus(null)
            await loadGrid()
          }
        }
      } catch {
        /* transient — try again next tick */
      }
    }
    const timer = setInterval(tick, 30_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [status?.loggedIn, syncWatching, loadGrid, refreshGrid, pushLog])

  async function doSell(item: GridItem) {
    if (!item.marketable || !!item.listing || sellingIds.includes(item.assetid)) return
    const priceCents = eurosToCents(sellPrices[item.assetid] ?? '')
    if (priceCents == null) {
      pushLog('err', `sell ${item.name}: enter a positive price in euros (e.g. 12,50)`)
      return
    }
    setSellingIds((prev) => [...prev, item.assetid])
    try {
      const r = await api<{ success: boolean; needs_mobile_confirmation: boolean; message?: string }>('/api/sell', {
        method: 'POST',
        body: JSON.stringify({ assetid: item.assetid, contextid: item.contextid, price: priceCents }),
      })
      const state = r.needs_mobile_confirmation ? 'needs your confirmation in Steam Mobile' : r.success ? 'listed' : 'failed'
      pushLog(r.success ? 'ok' : 'err', `sell ${item.name} @ ${formatEuro(priceCents)}: ${state}${r.message ? ` (${r.message})` : ''}`)
    } catch (err) {
      pushLog('err', `sell ${item.name}: ${(err as Error).message}`)
    } finally {
      setSellingIds((prev) => prev.filter((id) => id !== item.assetid))
    }
  }

  async function doCancel(listingid: string) {
    try {
      const r = await api<{ success: boolean }>('/api/cancel', { method: 'POST', body: JSON.stringify({ listingid }) })
      pushLog(r.success ? 'ok' : 'err', `cancel ${listingid}: ${r.success ? 'done' : 'failed'}`)
      await loadGrid()
    } catch (err) {
      pushLog('err', `cancel: ${(err as Error).message}`)
    }
  }

  function marketIcon(item: GridItem): string {
    if (!item.icon_url) return ''
    return `https://community.cloudflare.steamstatic.com/economy/image/${item.icon_url}`
  }

  const renderCard = (item: GridItem) => {
    const wear = wearOf(item.market_hash_name)
    const st = isStatTrak(item.name, item.market_hash_name)
    const listing = item.listing
    const steam = item.prices.steam
    const csfloat = item.prices.csfloat
    const stickers = parseStickers(csfloat?.stickers)
    const ownStickersRaw = item.own
      ? (() => {
          try {
            return JSON.parse(item.own.stickers ?? 'null')
          } catch {
            return null
          }
        })()
      : null
    const ownStickerCount =
      ownStickersRaw && Array.isArray(ownStickersRaw.stickers) ? ownStickersRaw.stickers.length : 0
    const stickerCount = item.own ? ownStickerCount : stickers.length
    const isCharm = /^charm \|/i.test(item.name) || /^charm \|/i.test(item.market_hash_name)
    const charmPattern = ownStickersRaw?.keychains?.length ? ownStickersRaw.keychains[0].pattern : null
    const ownStickersArr =
      ownStickersRaw && Array.isArray(ownStickersRaw.stickers)
        ? (ownStickersRaw.stickers as Array<{ stickerId: number; slot: number; wear?: number; name?: string | null; image?: string | null }>)
        : []
    const ownKeychainsArr =
      ownStickersRaw && Array.isArray(ownStickersRaw.keychains)
        ? (ownStickersRaw.keychains as Array<{
            stickerId: number
            slot: number
            pattern?: number
            name?: string | null
            image?: string | null
            steam_cents?: number | null
            csfloat_cents?: number | null
            steam_median_cents?: number | null
            steam_buy_cents?: number | null
            steam_buy_count?: number | null
            steam_volume?: number | null
          }>)
        : []
    const showFloat = isCharm ? false : item.own ? item.own.float_value != null : csfloat?.float_value != null
    const showSeed = isCharm ? false : item.own ? item.own.paint_seed != null : csfloat?.paint_seed != null
    const showIdentity = isCharm || showFloat || showSeed
    return (
      <article className="item-card" key={item.assetid}>
        <div className="c-head">
          <h3 className="c-title">
            {baseName(item.name)}
            {st && <span className="stat-badge">StatTrak</span>}
          </h3>
        </div>

        <div className="c-body">
          <div className="c-id">
            <div className="c-img">
              <img src={marketIcon(item)} alt="" loading="lazy" />
            </div>
            {showIdentity && (
              <div className="c-float">
                {wear && <span className="wear-badge">{wear}</span>}
                {isCharm ? (
                  <div className="c-frow">
                    <span className="k">Pattern</span>
                    <span className="fv own-float">{charmPattern ?? '—'}</span>
                  </div>
                ) : (
                  <>
                    {showFloat && (
                      <div className="c-frow">
                        <span className="k">Float</span>
                        <span className={`fv${item.own ? ' own-float' : ''}`}>
                          {item.own ? formatFloat(item.own.float_value) : formatFloat(csfloat?.float_value)}
                        </span>
                      </div>
                    )}
                    {showSeed && (
                      <div className="c-frow">
                        <span className="k">Seed</span>
                        <span className="fv">{item.own ? item.own.paint_seed ?? '—' : csfloat?.paint_seed ?? '—'}</span>
                      </div>
                    )}
                  </>
                )}
                {stickerCount > 0 && <span className="vol">{stickerCount} sticker{stickerCount > 1 ? 's' : ''}</span>}
              </div>
            )}
          </div>

          <div className="c-prices">
            <section className="c-sec">
              <h4>Steam</h4>
              <div className="c-row">
                <span className="k" title="Current lowest listed price">
                  Floor
                </span>
                <span className="v price">{formatGridPrice(steam)}</span>
              </div>
              {(steam?.median_cents != null || steam?.volume != null) && (
                <div className="c-row sub">
                  <span className="k" title="Median of sales in the last 24h">
                    Median
                  </span>
                  <span className="v price">{steam?.median_cents != null ? formatAmount(steam.median_cents, 'EUR') : '—'}</span>
                  {steam?.volume != null && <span className="vol">×{steam.volume}</span>}
                </div>
              )}
              {steam?.highest_buy_cents != null && (
                <div className="c-row sub">
                  <span className="k" title="Best current buy offer">
                    Buy depth
                  </span>
                  <span className="v">{formatAmount(steam.highest_buy_cents, 'EUR')}</span>
                  {steam?.buy_count != null && <span className="vol">×{steam.buy_count}</span>}
                </div>
              )}
            </section>
            <section className="c-sec">
              <h4>CSFloat</h4>
              <div className="c-row">
                <span className="k">Floor</span>
                <span className="v price">{formatGridPrice(csfloat)}</span>
              </div>
            </section>
          </div>
        </div>

        {!isCharm && (ownStickersArr.length > 0 || ownKeychainsArr.length > 0) && (
          <div className="c-subrows">
            <span className="c-subrows-label">Attached</span>
            {ownKeychainsArr.map((k, i) => (
              <div className="c-subrow" key={`ck-${k.stickerId}-${i}`}>
                <div className="sub-head">
                  <span className="sub-name">Charm | {k.name ?? `#${k.stickerId}`}</span>
                </div>
                <div className="sub-body">
                  <div className="c-id">
                    <div className="c-img">{k.image && <img src={k.image} alt="" loading="lazy" />}</div>
                    <div className="c-float">
                      <div className="c-frow">
                        <span className="k">Pattern</span>
                        <span className="fv own-float">{k.pattern ?? '—'}</span>
                      </div>
                    </div>
                  </div>
                  <section className="c-sec">
                    <h4>Steam</h4>
                    <div className="c-row">
                      <span className="k" title="Current lowest listed price">
                        Floor
                      </span>
                      <span className="v price">{k.steam_cents != null ? formatAmount(k.steam_cents, 'EUR') : '—'}</span>
                    </div>
                    {(k.steam_median_cents != null || k.steam_volume != null) && (
                      <div className="c-row sub">
                        <span className="k" title="Median of sales in the last 24h">
                          Median
                        </span>
                        <span className="v price">
                          {k.steam_median_cents != null ? formatAmount(k.steam_median_cents, 'EUR') : '—'}
                        </span>
                        {k.steam_volume != null && <span className="vol">×{k.steam_volume}</span>}
                      </div>
                    )}
                    {k.steam_buy_cents != null && (
                      <div className="c-row sub">
                        <span className="k" title="Best current buy offer">
                          Buy depth
                        </span>
                        <span className="v">{formatAmount(k.steam_buy_cents, 'EUR')}</span>
                        {k.steam_buy_count != null && <span className="vol">×{k.steam_buy_count}</span>}
                      </div>
                    )}
                  </section>
                  <section className="c-sec">
                    <h4>CSFloat</h4>
                    <div className="c-row">
                      <span className="k">Floor</span>
                      <span className="v price">{k.csfloat_cents != null ? formatAmount(k.csfloat_cents, 'USD') : '—'}</span>
                    </div>
                  </section>
                </div>
              </div>
            ))}
            {ownStickersArr.map((s, i) => (
              <div className="c-subrow" key={`cs-${s.stickerId}-${i}`}>
                <div className="sub-head">
                  <span className="sub-name">Sticker | {s.name ?? `#${s.stickerId}`}</span>
                </div>
                <div className="sub-body sub-body--narrow">
                  <div className="c-id">
                    <div className="c-img">{s.image && <img src={s.image} alt="" loading="lazy" />}</div>
                    <div className="c-float">
                      <div className="c-frow">
                        <span className="k">Slot</span>
                        <span className="fv">{s.slot}</span>
                      </div>
                      {s.wear != null && s.wear > 0 && (
                        <div className="c-frow">
                          <span className="k">Wear</span>
                          <span className="fv">worn</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="c-foot">
          <p
            className="muted c-synced"
            title={item.pricesSyncedAt ? `Prices synced ${new Date(item.pricesSyncedAt).toLocaleString()}` : 'No price snapshots yet'}
          >
            prices synced {item.pricesSyncedAt != null ? relTime(item.pricesSyncedAt) : 'never'}
          </p>
          <div className="c-foot-right">
            <span className={`badge ${listing || item.marketable ? 'ok' : 'muted'}`}>
              {listing ? 'listed' : item.marketable ? 'marketable' : 'restricted'}
            </span>
            <button className="btn btn-primary" onClick={() => openDetail(item)}>
              {listing ? 'Manage listing' : item.marketable ? 'Sell' : 'Details'}
            </button>
          </div>
        </div>
      </article>
    )
  }

  const renderDetailModal = (item: GridItem) => {
    const current = grid?.items.find((i) => i.assetid === item.assetid) ?? item
    const wear = wearOf(item.market_hash_name)
    const st = isStatTrak(item.name, item.market_hash_name)
    const isCharm = /^charm \|/i.test(item.name) || /^charm \|/i.test(item.market_hash_name)
    const idParts: string[] = []
    if (!isCharm) {
      if (item.own?.float_value != null) idParts.push(`Float ${formatFloat(item.own.float_value)}`)
      if (item.own?.paint_seed != null) idParts.push(`Seed ${item.own.paint_seed}`)
    }
    let stickerCount = 0
    try {
      const own = item.own?.stickers ? (JSON.parse(item.own.stickers) as { stickers?: unknown[] }) : null
      if (own && Array.isArray(own.stickers)) stickerCount = own.stickers.length
    } catch {
      /* ignore malformed sticker payloads */
    }
    if (stickerCount === 0) stickerCount = parseStickers(item.prices.csfloat?.stickers).length
    return (
      <div className="modal-panel" role="dialog" aria-modal="true" aria-label={item.name} onClick={(e) => e.stopPropagation()}>
        <div className="detail-head">
          <div className="detail-img">
            <img src={marketIcon(item)} alt="" loading="lazy" />
          </div>
          <div className="detail-title">
            <h2>{item.name}</h2>
            <div className="detail-meta">
              {wear && <span className="wear-badge">{wear}</span>}
              {st && <span className="stat-badge">StatTrak</span>}
              {item.rarity?.name && <span className="badge">{item.rarity.name}</span>}
            </div>
            <p className="muted mono">{item.market_hash_name}</p>
            {(idParts.length > 0 || stickerCount > 0) && (
              <p className="muted detail-id">
                {idParts.join(' · ')}
                {stickerCount > 0 && `${idParts.length > 0 ? ' · ' : ''}${stickerCount} sticker${stickerCount > 1 ? 's' : ''} attached`}
              </p>
            )}
          </div>
          <button className="btn btn-icon modal-close" aria-label="Close" onClick={closeDetail}>
            ×
          </button>
        </div>

        <div className="detail-body">
          {!compare ? (
            <p className="muted">{compareLoading ? 'Fetching live prices…' : 'No live price data for this item yet.'}</p>
          ) : (
            <>
              {compare.bestVenue && compare.deltaPercent != null && (
                <p className="verdict">
                  {compare.bestVenue === 'csfloat'
                    ? `CSFloat nets ${Math.abs(compare.deltaPercent).toFixed(1)}% more than Steam.`
                    : `Steam nets ${Math.abs(compare.deltaPercent).toFixed(1)}% more than CSFloat (before wallet-vs-cash trade-offs).`}
                </p>
              )}
              <div className="compare-cols">
                <div className="compare-col">
                  <h3>Steam ({compare.listed ? 'listed' : 'not listed'})</h3>
                  <table>
                    <tbody>
                      <tr>
                        <td>Floor (buyer pays)</td>
                        <td>{compare.steam.lowest_cents != null ? formatAmount(compare.steam.lowest_cents, 'EUR') : '—'}</td>
                      </tr>
                      <tr>
                        <td>Volume 24h</td>
                        <td>{compare.steam.volume ?? '—'}</td>
                      </tr>
                      <tr>
                        <td>Top buy order</td>
                        <td>{compare.steam.highest_buy_cents != null ? formatAmount(compare.steam.highest_buy_cents, 'EUR') : '—'}</td>
                      </tr>
                      <tr>
                        <td>Buy order quantity</td>
                        <td>{compare.steam.buy_count ?? '—'}</td>
                      </tr>
                      <tr className="net">
                        <td>Net after ~15% fee</td>
                        <td>{compare.steam.net_cents != null ? formatAmount(compare.steam.net_cents, 'EUR') : '—'}</td>
                      </tr>
                      {compare.steam.error && (
                        <tr>
                          <td colSpan={2} className="muted">
                            {compare.steam.error}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="compare-col">
                  <h3>CSFloat cash-out</h3>
                  {compare.csfloat ? (
                    <table>
                      <tbody>
                        <tr>
                          <td>Floor (buyer pays)</td>
                          <td>{compare.csfloat.lowest_cents != null ? formatAmount(compare.csfloat.lowest_cents, 'USD') : '—'}</td>
                        </tr>
                        <tr>
                          <td>Float ref</td>
                          <td>{formatFloat(compare.csfloat.float_value)}</td>
                        </tr>
                        <tr>
                          <td>Paint seed</td>
                          <td>{compare.csfloat.paint_seed ?? '—'}</td>
                        </tr>
                        <tr>
                          <td>Stickers</td>
                          <td>
                            {compare.csfloat.stickers?.length
                              ? compare.csfloat.stickers.map((s) => (s.slot > 0 ? `[${s.slot}] ` : '') + s.name).join(', ')
                              : '—'}
                          </td>
                        </tr>
                        <tr className="net">
                          <td>Net after 2% fee</td>
                          <td>{compare.csfloat.net_cents != null ? formatAmount(compare.csfloat.net_cents, 'USD') : '—'}</td>
                        </tr>
                        {compare.csfloat.error && (
                          <tr>
                            <td colSpan={2} className="muted">
                              {compare.csfloat.error}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  ) : (
                    <p className="muted">No CSFloat data synced for this item yet.</p>
                  )}
                </div>
              </div>
              <p className="muted footnote">
                Steam prices in EUR, CSFloat in USD; nets converted with a fixed rate for comparison. Steam proceeds stay in your
                wallet (not cash); CSFloat is a real cash-out.
              </p>
            </>
          )}
        </div>

        <div className="modal-sell">
          <div className="c-status">
            <span className={`badge ${current.listing || current.marketable ? 'ok' : 'muted'}`}>
              {current.listing ? 'listed' : current.marketable ? 'marketable' : 'restricted'}
            </span>
            {current.listing?.price_cents != null && <span className="mono price">{formatEuro(current.listing.price_cents)}</span>}
          </div>
          <div className="sell-row">
            <input
              placeholder="Sell €"
              value={sellPrices[current.assetid] ?? ''}
              onChange={(e) => setSellPrices((prev) => ({ ...prev, [current.assetid]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doSell(current)
              }}
              disabled={!current.marketable || !!current.listing || sellingIds.includes(current.assetid)}
              inputMode="decimal"
              autoComplete="off"
            />
            <button
              className="btn btn-primary"
              onClick={() => void doSell(current)}
              disabled={!current.marketable || !!current.listing || sellingIds.includes(current.assetid)}
            >
              {sellingIds.includes(current.assetid) ? 'Selling…' : 'Sell'}
            </button>
            {current.listing && (
              <button className="btn btn-ghost" onClick={() => current.listing && void doCancel(current.listing.listingid)}>
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  const view = useMemo<{ groups: RarityGroup<GridItem>[] | null; items: GridItem[] | null }>(() => {
    if (!grid) return { groups: null, items: null }
    const items = listedOnly ? grid.items.filter((i) => i.listing) : grid.items
    if (!grouping) return { groups: null, items }
    return { groups: groupByRarity(items), items: null }
  }, [grid, grouping, listedOnly])

  useEffect(() => {
    // Logged-out = no inventory view at all: every inventory-related section is
    // gated on status.loggedIn, so stale counts/listings never render and the
    // grid is only (re)loaded once signed back in.
    if (!status?.loggedIn) return undefined
    const timer = setTimeout(() => {
      void loadGrid()
    }, 0)
    return () => clearTimeout(timer)
  }, [loadGrid, status?.loggedIn])

  return (
    <div className="app">
      <header className="appbar">
        <h1>SkinHQ</h1>
        <div className="appbar-right">
          {status?.loggedIn && (
            <span className="acct" title={status.steamid ?? undefined}>
              {status.accountName ?? status.steamid}
            </span>
          )}
          <button
            className="btn btn-icon"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
            title="Settings"
          >
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>

      {status && !status.loggedIn && (
        <section className="card signin">
          <h2>Sign in to Steam</h2>
          {status.session?.state === 'dead' && <p className="hint hint-err">Steam session expired — sign in again.</p>}
          {loginError && <p className="hint hint-err">{loginError}</p>}
          <input
            placeholder="Steam account name"
            value={accountName}
            onChange={(e) => {
              setAccountName(e.target.value)
              setLoginError(null)
            }}
          />
          <input
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value)
              setLoginError(null)
            }}
          />
          {needsCode != null ? (
            <>
              <p className="hint">
                {needsCode === 'email'
                  ? 'Steam sent a guard code to your email — enter it below.'
                  : 'Enter the current Steam Guard code from the Steam Mobile app.'}
              </p>
              <input
                placeholder="Steam Guard code"
                value={twoFactorCode}
                onChange={(e) => {
                  setTwoFactorCode(e.target.value)
                  setLoginError(null)
                }}
              />
              <button className="btn btn-primary" onClick={() => void submitCode()} disabled={!twoFactorCode.trim()}>
                Sign in with code
              </button>
            </>
          ) : pendingApproval ? (
            <>
              <p className="hint">Approve the sign-in prompt in your Steam Mobile app.</p>
              <button className="btn btn-primary" disabled>
                Waiting for approval…
              </button>
              <button className="btn btn-ghost" onClick={() => void doLogout()}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={() => void doLogin()} disabled={!accountName || !password}>
              Sign in
            </button>
          )}
        </section>
      )}

{status?.loggedIn && (
        <section className="statusbar">
          <button className="btn btn-primary" onClick={() => void syncNow()} disabled={gridLoading}>
            {gridLoading ? 'Syncing…' : 'Sync now'}
          </button>
          {syncDisplay?.running && (
            <span className="chip prog">
              {syncDisplay.phase}
              {syncDisplay.phase === 'prices' && syncDisplay.total > 0 ? ` ${syncDisplay.current}/${syncDisplay.total}` : '…'}
            </span>
          )}
          {!syncDisplay?.running && syncDisplay?.last.prices && (
            <span className="muted">prices up to {relTime(syncDisplay.last.prices)}</span>
          )}
          {!!syncDisplay?.autoSyncMin && syncDisplay.autoSyncMin > 0 && (
            <span className="chip">{formatAutoSyncMin(syncDisplay.autoSyncMin)}</span>
          )}
          {status?.session?.state === 'throttled' && (
            <span className="chip chip-warn">Steam rate-limiting this session — sync may be delayed.</span>
          )}
        </section>
      )}

      {status?.loggedIn && (syncDisplay?.errors ?? []).some((e) => !dismissedErrors.includes(e)) && (
        <div className="toasts">
          {(syncDisplay?.errors ?? [])
            .filter((e) => !dismissedErrors.includes(e))
            .map((e, idx) => (
              <div className="toast" key={idx}>
                <span>{e}</span>
                <button
                  className="btn btn-icon"
                  aria-label="Dismiss"
                  onClick={() => setDismissedErrors((prev) => [...prev, e])}
                >
                  ×
                </button>
              </div>
            ))}
        </div>
      )}

      {status?.loggedIn && detail && (
        <>
          <div className="scrim" onClick={closeDetail} />
          <div className="modal" onClick={closeDetail}>
            {renderDetailModal(detail)}
          </div>
        </>
      )}

      {status?.loggedIn && (
        <section className="workspace">
        <div className="grid-head">
          <div>
            <h2>Inventory</h2>
            <p className="muted counts">
              {listedOnly
                ? `${grid?.items.filter((i) => i.listing).length ?? 0} listed shown`
                : `${grid?.counts.inventory ?? 0} owned · ${grid?.counts.marketable ?? 0} marketable · ${grid?.counts.listed ?? 0} listed`}
            </p>
          </div>
          <div className="head-tools">
            <button className="btn btn-ghost" onClick={() => setListedOnly((v) => !v)}>
              {listedOnly ? 'All items' : 'Listed only'}
            </button>
            <button className="btn btn-ghost" onClick={() => setGrouping((v) => !v)}>
              {grouping ? 'Flat list' : 'Group by rarity'}
            </button>
          </div>
        </div>
        {(!grid || grid.items.length === 0) && (
          <p className="muted">Nothing sellable yet. Sign in and hit “Sync now” to pull your inventory and market prices.</p>
        )}
        {view?.groups ? (
          view.groups.map((group) => (
            <div className="group" key={group.key}>
              <div className="group-head">
                <span className="group-name">{group.label}</span>
                <span className="group-count">{group.items.length}</span>
              </div>
              <div className="cards">{group.items.map(renderCard)}</div>
            </div>
          ))
        ) : grid && grid.items.length > 0 ? (
          <div className="cards">{(view?.items ?? grid.items).map(renderCard)}</div>
        ) : null}
      </section>
      )}

      <footer>
        <button className="btn btn-ghost btn-sm" onClick={() => setDockOpen((v) => !v)}>
          {dockOpen ? 'Hide activity' : 'Show activity'}
        </button>
      </footer>

      {log.length > 0 && (
        <aside className={`dock${dockOpen ? '' : ' dock-closed'}`}>
          <div className="dock-head">
            <span>Activity</span>
            <span className="group-count">{log.length}</span>
            <button
              className="btn btn-icon"
              aria-label={dockOpen ? 'Collapse activity' : 'Expand activity'}
              onClick={() => setDockOpen((v) => !v)}
            >
              {dockOpen ? '▾' : '▴'}
            </button>
          </div>
          <ul>
            {[...log].reverse().map((line, i) => (
              <li key={i} className={line.kind}>
                {line.text}
              </li>
            ))}
          </ul>
        </aside>
      )}

      {settingsOpen && (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings" onClick={() => setSettingsOpen(false)}>
          <div className="settings-card" onClick={(e) => e.stopPropagation()}>
            <button className="btn btn-icon card-close" aria-label="Close settings" onClick={() => setSettingsOpen(false)}>
              ×
            </button>

            <div className="settings-brand">
              <span className="settings-logo" aria-hidden="true" />
              <h2>SkinHQ</h2>
              <p className="settings-sub">Steam + CSFloat listing workspace · local &amp; single-user</p>
            </div>

            {status?.loggedIn && (
              <section className="settings-sec">
                <span className="settings-heading">Account</span>
                <div className="settings-row">
                  <span className="mono muted">
                    {status.accountName ?? 'Signed in'}
                    {status.steamid ? ` · ${status.steamid}` : ''}
                  </span>
                  <button className="btn btn-ghost" onClick={() => void doLogout().then((ok) => { if (ok) setSettingsOpen(false) })}>
                    Log out
                  </button>
                </div>
              </section>
            )}

            <section className="settings-sec">
              <span className="settings-heading">UI style</span>
              <div className="theme-picker" role="radiogroup" aria-label="UI style">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={theme === t.id}
                    className={`theme-chip${theme === t.id ? ' active' : ''}`}
                    onClick={() => setTheme(t.id)}
                  >
                    <span className="theme-swatch" style={{ background: t.bg }}>
                      <span className="theme-swatch-dot" style={{ background: t.accent }} />
                    </span>
                    <span className="theme-label">{t.label}</span>
                  </button>
                ))}
              </div>
            </section>

            <p className="settings-build">
              {__BUILD_SHA__ === 'dev' ? (
                'development build'
              ) : (
                <>
                  <a href={`https://github.com/${__REPO__}/commit/${__BUILD_SHA__}`} target="_blank" rel="noopener noreferrer">
                    {__BUILD_SHA__.slice(0, 7)}
                  </a>
                  {__BUILD_TIME__ ? (
                    <>
                      {' · '}
                      {new Date(__BUILD_TIME__).toLocaleDateString([], {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </>
                  ) : null}
                  {' · '}
                  <a href={`https://github.com/${__REPO__}/issues`} target="_blank" rel="noopener noreferrer">
                    Report an issue
                  </a>
                </>
              )}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}