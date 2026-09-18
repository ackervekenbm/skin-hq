import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'

interface AuthStatus {
  loggedIn: boolean
  steamid: string | null
  pendingLogin?: 'approval' | 'email' | 'mobile' | null
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
  prices: Record<string, GridPrice>
  listing: { listingid: string; price_cents: number | null } | null
}

interface SyncStatus {
  running: boolean
  startedAt: string | null
  phase: 'idle' | 'inventory' | 'listings' | 'prices'
  current: number
  total: number
  last: { inventory: string | null; listings: string | null; prices: string | null }
  errors: string[]
}

interface GridResponse {
  refreshedAt: string | null
  counts: { inventory: number; marketable: number; listed: number }
  sync: SyncStatus
  items: GridItem[]
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
  if (!p || p.lowest_cents == null) return '—'
  return formatAmount(p.lowest_cents, p.provider === 'csfloat' ? 'USD' : 'EUR')
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
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
  const [log, setLog] = useState<LogLine[]>([])

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

  const loadGrid = useCallback(async () => {
    try {
      const g = await api<GridResponse>('/api/grid')
      setGrid(g)
    } catch (err) {
      pushLog('err', `grid: ${(err as Error).message}`)
    }
  }, [pushLog])

  async function syncNow() {
    if (!status?.loggedIn) {
      pushLog('err', 'sync: sign in to Steam first')
      return
    }
    setGridLoading(true)
    try {
      const r = await api<{ started: boolean; sync: SyncStatus }>('/api/sync', { method: 'POST' })
      if (!r.started) pushLog('warn', 'Sync already running')
      else pushLog('ok', 'Sync started — inventory, listings, prices')
    } catch (err) {
      pushLog('err', `sync: ${(err as Error).message}`)
      setGridLoading(false)
      return
    }
    for (let i = 0; i < 600; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      let running = true
      try {
        running = (await api<SyncStatus>('/api/sync/status')).running
      } catch {
        /* keep polling */
      }
      await loadGrid()
      if (!running) break
    }
    setGridLoading(false)
    pushLog('ok', 'Sync finished')
  }

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
    return (
      <article className="item-card" key={item.assetid}>
        <div className="c-title">{baseName(item.name)}</div>
        <div className="c-img">
          <img src={marketIcon(item)} alt="" loading="lazy" />
        </div>
        <div className="c-badges">
          {wear && <span className="wear">{wear}</span>}
          {st && <span className="stat">StatTrak</span>}
        </div>
        <div className="c-details">
          <div className="c-row">
            <span className="k">Steam</span>
            <span className="v">{formatGridPrice(item.prices.steam)}</span>
            {item.prices.steam?.volume != null && <span className="vol">×{item.prices.steam.volume}</span>}
          </div>
          <div className="c-row">
            <span className="k">CSFloat</span>
            <span className="v">{formatGridPrice(item.prices.csfloat)}</span>
          </div>
          <div className="c-row">
            <span className="k">Status</span>
            <span className={`badge ${listing || item.marketable ? 'ok' : 'muted'}`}>
              {listing ? `listed · ${formatEuro(listing.price_cents)}` : item.marketable ? 'marketable' : 'restricted'}
            </span>
          </div>
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
          <button onClick={() => void doSell(item)} disabled={!status?.loggedIn || !item.marketable || !!listing}>
            Sell
          </button>
          {listing && (
            <button className="ghost" onClick={() => void doCancel(listing.listingid)}>
              Cancel
            </button>
          )}
        </div>
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
    const timer = setTimeout(() => {
      void loadGrid()
    }, 0)
    return () => clearTimeout(timer)
  }, [loadGrid, status?.loggedIn])

  return (
    <div className="app">
      <header>
        <h1>SkinHQ</h1>
        <span className="build">spike · {status?.loggedIn ? `signed in as ${status.steamid}` : 'not signed in to Steam'}</span>
      </header>

      <section className="card auth">
        <input placeholder="Steam account name" value={accountName} onChange={(e) => setAccountName(e.target.value)} />
        <input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {status?.loggedIn ? (
          <button onClick={() => void doLogout()}>Log out</button>
        ) : (
          <>
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

      <section className="card actions">
        <button onClick={() => void syncNow()} disabled={!status?.loggedIn || gridLoading}>
          {gridLoading ? 'Syncing…' : 'Sync now'}
        </button>
        {grid?.sync.running && (
          <span className="mono sync-progress">
            {grid.sync.phase}
            {grid.sync.phase === 'prices' && grid.sync.total > 0 ? ` ${grid.sync.current}/${grid.sync.total}` : '…'}
          </span>
        )}
        {!grid?.sync.running && grid?.sync.last.prices && <span className="muted">prices up to {relTime(grid.sync.last.prices)}</span>}
      </section>

      {!!grid?.sync.errors.length && (
        <section className="card sync-errors">
          <h3>Sync issues</h3>
          <ul>
            {grid.sync.errors.map((e, idx) => (
              <li key={idx}>{e}</li>
            ))}
          </ul>
        </section>
      )}

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