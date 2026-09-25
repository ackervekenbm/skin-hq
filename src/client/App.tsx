import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'

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

interface GridPrice {
  provider: string
  lowest_cents: number | null
  median_cents: number | null
  volume: number | null
  sell_count: number | null
  buy_count: number | null
  highest_buy_cents: number | null
  float_value: number | null
  paint_seed: number | null
  stickers: string | null
  had_error: number
  note?: string | null
  fetched_at: string
}

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

interface StickerRef {
  name: string
  slot: number
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

interface RarityGroup {
  key: string
  label: string
  rank: number
  items: GridItem[]
}

function formatEuro(cents: number | null | undefined): string {
  if (cents == null) return '—'
  return `€${(cents / 100).toFixed(2)}`
}

function formatAmount(cents: number, currency: 'EUR' | 'USD'): string {
  return `${currency === 'USD' ? '$' : '€'}${(cents / 100).toFixed(2)}`
}

function formatGridPrice(p: GridPrice | null | undefined): string {
  if (!p || p.lowest_cents == null) {
    // Steam returns a "0,00 €" placeholder for lowest_price when nothing is
    // actively listed even though the item still trades (median/volume are
    // real). A successful fetch with no lowest is "no listings", not "no
    // data" — surface that state instead of a bare dash.
    return p && p.had_error === 0 ? 'no listings' : '—'
  }
  return formatAmount(p.lowest_cents, p.provider === 'csfloat' ? 'USD' : 'EUR')
}

function formatFloat(f: number | null | undefined): string {
  if (f == null) return '—'
  return f.toFixed(4)
}

function parseStickers(raw: string | null | undefined): StickerRef[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as StickerRef[]
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

function formatAutoSyncMin(min: number): string {
  return min % 60 === 0 ? `auto-sync every ${min / 60}h` : `auto-sync every ${min}m`
}

function wearOf(hash: string): string {
  const m = hash.match(/\(([^)]+)\)$/)
  return m ? m[1] : ''
}

function isStatTrak(name: string, hash: string): boolean {
  return /^StatTrak/i.test(name) || /^StatTrak/i.test(hash)
}

function baseName(name: string): string {
  return name.replace(/^StatTrak\u2122?\s*/i, '').replace(/\s*\([^)]+\)$/, '').trim()
}

function eurosToCents(input: string): number | null {
  const text = input.trim().replace(/[€\s]/g, '').replace(',', '.')
  const amount = Number(text)
  if (!Number.isFinite(amount) || amount <= 0) return null
  return Math.round(amount * 100)
}

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
  const [grid, setGrid] = useState<GridResponse | null>(null)
  const [gridLoading, setGridLoading] = useState(false)
  const [groupByRarity, setGroupByRarity] = useState(true)
  const [listedOnly, setListedOnly] = useState(false)
  const [sellPrices, setSellPrices] = useState<Record<string, string>>({})
  const [compare, setCompare] = useState<CompareRow | null>(null)
  const [compareLoading, setCompareLoading] = useState(false)
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

  async function doLogin() {
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
      pushLog('ok', `Logged in as ${accountName}`)
    } catch (err) {
      setPendingApproval(false)
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
    try {
      const s = await api<AuthStatus>('/api/auth/guard', {
        method: 'POST',
        body: JSON.stringify({ code: twoFactorCode.trim() }),
      })
      setNeedsCode(null)
      setTwoFactorCode('')
      setPassword('')
      setStatus(s)
      pushLog('ok', 'Signed in to Steam')
    } catch (err) {
      pushLog('err', `code: ${(err as Error).message}`)
    }
  }

  async function doLogout() {
    await api('/api/auth/logout', { method: 'POST' })
    setStatus({ loggedIn: false, steamid: null })
    setNeedsCode(null)
    setPendingApproval(false)
    pushLog('ok', 'Logged out')
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

  async function openCompare(hash: string) {
    setCompare(null)
    await loadCompare(hash)
  }

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
    const priceCents = eurosToCents(sellPrices[item.assetid] ?? '')
    if (priceCents == null) {
      pushLog('err', `sell ${item.name}: enter a positive price in euros (e.g. 12,50)`)
      return
    }
    try {
      const r = await api<{ success: boolean; needs_mobile_confirmation: boolean; message?: string }>('/api/sell', {
        method: 'POST',
        body: JSON.stringify({ assetid: item.assetid, contextid: item.contextid, price: priceCents }),
      })
      const state = r.needs_mobile_confirmation ? 'needs your confirmation in Steam Mobile' : r.success ? 'listed' : 'failed'
      pushLog(r.success ? 'ok' : 'err', `sell ${item.name} @ ${formatEuro(priceCents)}: ${state}${r.message ? ` (${r.message})` : ''}`)
    } catch (err) {
      pushLog('err', `sell ${item.name}: ${(err as Error).message}`)
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
    const sellsDisabled = !status?.loggedIn || !item.marketable || !!listing
    return (
      <article className="item-card" key={item.assetid}>
        <div className="c-head">
          <h3 className="c-title">{baseName(item.name)}</h3>
          {st && <span className="stat-badge">StatTrak</span>}
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

          <p
            className="muted c-synced"
            title={item.pricesSyncedAt ? `Prices synced ${new Date(item.pricesSyncedAt).toLocaleString()}` : 'No price snapshots yet'}
          >
            prices synced {item.pricesSyncedAt != null ? relTime(item.pricesSyncedAt) : 'never'}
          </p>

          <section className="c-sec sell">
            <h4>Sell</h4>
            <div className="c-status">
              <span className={`badge ${listing || item.marketable ? 'ok' : 'muted'}`}>
                {listing ? 'listed' : item.marketable ? 'marketable' : 'restricted'}
              </span>
              {listing && <span className="mono price">{formatEuro(listing.price_cents)}</span>}
            </div>
            <div className="c-actions">
              <input
                placeholder="Sell €"
                value={sellPrices[item.assetid] ?? ''}
                onChange={(e) => setSellPrices((prev) => ({ ...prev, [item.assetid]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doSell(item)
                }}
              />
              <button onClick={() => void doSell(item)} disabled={sellsDisabled}>
                Sell
              </button>
              {listing && (
                <button className="ghost" onClick={() => void doCancel(listing.listingid)}>
                  Cancel
                </button>
              )}
              <button className="ghost" onClick={() => void openCompare(item.market_hash_name)} disabled={compareLoading}>
                Compare
              </button>
            </div>
          </section>
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
      </article>
    )
  }

  const view = useMemo<{ groups: RarityGroup[] | null; items: GridItem[] | null }>(() => {
    if (!grid) return { groups: null, items: null }
    const items = listedOnly ? grid.items.filter((i) => i.listing) : grid.items
    if (!groupByRarity) return { groups: null, items }
    const groups = new Map<string, GridItem[]>()
    for (const item of items) {
      const key = item.rarity?.internal_name ?? 'unranked'
      const arr = groups.get(key) ?? []
      arr.push(item)
      groups.set(key, arr)
    }
    const sorted: RarityGroup[] = Array.from(groups.entries())
      .map(([key, gitems]) => ({
        key,
        label: gitems[0]?.rarity?.name ?? 'Other',
        rank: gitems[0]?.rarity?.rank ?? 99,
        items: gitems,
      }))
      .sort((a, b) => a.rank - b.rank)
    return { groups: sorted, items: null }
  }, [grid, groupByRarity, listedOnly])

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
      <header>
        <h1>SkinHQ</h1>
        <span className="build">
          {status?.loggedIn ? `signed in as ${status.accountName ?? status.steamid}` : 'not signed in to Steam'}
        </span>
      </header>

      <section className="card auth">
        {status?.loggedIn ? (
          <div className="auth-signed-in">
            <span className="muted">Signed in as {status.accountName ?? status.steamid}</span>
            <button onClick={() => void doLogout()}>Log out</button>
          </div>
        ) : (
          <>
            {status?.session?.state === 'dead' && <p className="hint hint-err">Steam session expired — sign in again.</p>}
            <input placeholder="Steam account name" value={accountName} onChange={(e) => setAccountName(e.target.value)} />
            <input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            {needsCode != null ? (
              <>
                <p className="hint">
                  {needsCode === 'email'
                    ? 'Steam sent a guard code to your email — enter it below.'
                    : 'Enter the current Steam Guard code from the Steam Mobile app.'}
                </p>
                <input placeholder="Steam Guard code" value={twoFactorCode} onChange={(e) => setTwoFactorCode(e.target.value)} />
                <button onClick={() => void submitCode()} disabled={!twoFactorCode.trim()}>
                  Sign in with code
                </button>
              </>
            ) : pendingApproval ? (
              <>
                <p className="hint">Approve the sign-in prompt in your Steam Mobile app.</p>
                <button disabled>Waiting for approval…</button>
                <button onClick={() => void doLogout()}>Cancel</button>
              </>
            ) : (
              <button onClick={() => void doLogin()} disabled={!accountName || !password}>
                Sign in
              </button>
            )}
          </>
        )}
      </section>

{status?.loggedIn && (
        <section className="card actions">
          <button onClick={() => void syncNow()} disabled={!status?.loggedIn || gridLoading}>
            {gridLoading ? 'Syncing…' : 'Sync now'}
          </button>
          {syncDisplay?.running && (
            <span className="mono sync-progress">
              {syncDisplay.phase}
              {syncDisplay.phase === 'prices' && syncDisplay.total > 0 ? ` ${syncDisplay.current}/${syncDisplay.total}` : '…'}
            </span>
          )}
          {!syncDisplay?.running && syncDisplay?.last.prices && <span className="muted">prices up to {relTime(syncDisplay.last.prices)}</span>}
          {status?.session?.state === 'throttled' && (
            <p className="hint">Steam is rate-limiting this session — sync may be delayed.</p>
          )}
          {!!syncDisplay?.autoSyncMin && syncDisplay.autoSyncMin > 0 && (
            <span className="muted">{formatAutoSyncMin(syncDisplay.autoSyncMin)}</span>
          )}
        </section>
      )}

      {status?.loggedIn && compare && (
        <section className="card compare">
          <div className="compare-head">
            <div>
              <h2>
                Compare <span className="mono">{baseName(compare.name)}</span>
              </h2>
              <p className="muted">
                Steam wallet after ~15% fee vs CSFloat cash-out after 2% fee ({compare.netUsd.steam != null && compare.netUsd.csfloat != null ? 'net in USD' : 'net in native currency'}).
              </p>
            </div>
            <button className="ghost" onClick={() => setCompare(null)}>
              Close
            </button>
          </div>
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
        </section>
      )}

      {status?.loggedIn && !!(syncDisplay?.errors.length ?? 0) && (
        <section className="card sync-errors">
          <h3>Sync issues</h3>
          <ul>
            {(syncDisplay?.errors ?? []).map((e, idx) => (
              <li key={idx}>{e}</li>
            ))}
          </ul>
        </section>
      )}

      {status?.loggedIn && (
        <section className="card grid-card">
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
            <button className="toggle" onClick={() => setListedOnly((v) => !v)}>
              {listedOnly ? 'All items' : 'Listed only'}
            </button>
            <button className="toggle" onClick={() => setGroupByRarity((v) => !v)}>
              {groupByRarity ? 'Flat list' : 'Group by rarity'}
            </button>
          </div>
        </div>
        {(!grid || grid.items.length === 0) && (
          <p className="muted">Nothing sellable yet. Sign in and hit “Sync now” to pull your inventory and market prices.</p>
        )}
        {view?.groups ? (
          <div className="cards">
            {view.groups.map((group) => (
              <Fragment key={group.key}>
                <div className="group-head">
                  <span className="group-name">{group.label}</span>
                  <span className="group-count">{group.items.length}</span>
                </div>
                {group.items.map(renderCard)}
              </Fragment>
            ))}
          </div>
        ) : grid && grid.items.length > 0 ? (
          <div className="cards">{(view?.items ?? grid.items).map(renderCard)}</div>
        ) : null}
      </section>
      )}

      <section className="card log">
        <h2>Log</h2>
        {log.length === 0 && <p className="muted">No activity yet.</p>}
        <ul>
          {log.map((line, i) => (
            <li key={i} className={line.kind}>
              {line.text}
            </li>
          ))}
        </ul>
      </section>

      <footer>
        build {__BUILD_SHA__}
        {__BUILD_TIME__ ? ` · ${__BUILD_TIME__}` : ''} · repo {__REPO__}
      </footer>
    </div>
  )
}