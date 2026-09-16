import { useCallback, useEffect, useState } from 'react'

interface AuthStatus {
  loggedIn: boolean
  steamid: string | null
  pendingLogin?: 'approval' | 'email' | 'mobile' | null
}

type LoginResponse =
  | { loggedIn: true; steamid: string }
  | { needsApproval: true }
  | { needsCode: true; guard: 'email' | 'mobile'; emaildomain?: string }

interface InventoryItem {
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

interface ListingRow {
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

interface ItemPrice {
  provider: string
  currency: string
  lowest_cents: number | null
  volume?: number
  sell_count?: number
  buy_count?: number
  error?: string
}

interface LogLine {
  kind: 'ok' | 'warn' | 'err'
  text: string
}

function formatEuro(cents: number | null | undefined): string {
  if (cents == null) return '—'
  return `€${(cents / 100).toFixed(2)}`
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
  const [inventory, setInventory] = useState<InventoryItem[]>([])
  const [listings, setListings] = useState<ListingRow[]>([])
  const [prices, setPrices] = useState<Record<string, ItemPrice[]>>({})
  const [priceHash, setPriceHash] = useState('')
  const [profileInput, setProfileInput] = useState('')
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
    setInventory([])
    setListings([])
    pushLog('ok', 'Logged out')
  }

  async function loadInventory() {
    try {
      const { items } = await api<{ items: InventoryItem[]; total: number }>('/api/inventory')
      setInventory(items)
      pushLog('ok', `Inventory: ${items.length} items`)
    } catch (err) {
      pushLog('err', `inventory: ${(err as Error).message}`)
    }
  }

  async function loadPublicInventory() {
    try {
      let steamid = profileInput.trim()
      if (!/^\d{17}$/.test(steamid)) {
        const resolved = await api<{ steamid64: string }>(`/api/steamid?input=${encodeURIComponent(steamid)}`)
        steamid = resolved.steamid64
      }
      const { items, total } = await api<{ items: InventoryItem[]; total: number }>(
        `/api/inventory?steamid=${encodeURIComponent(steamid)}`,
      )
      setInventory(items)
      pushLog('ok', `Public inventory: ${items.length} of ${total} items`)
    } catch (err) {
      pushLog('err', `inventory: ${(err as Error).message}`)
    }
  }

  async function loadListings() {
    try {
      const { total, listings: rows } = await api<{ total: number; listings: ListingRow[] }>('/api/mylistings')
      setListings(rows)
      pushLog('ok', `Listings: ${total} total, ${rows.length} shown`)
    } catch (err) {
      pushLog('err', `listings: ${(err as Error).message}`)
    }
  }

  async function fetchPrice() {
    const hash = priceHash.trim()
    if (!hash) {
      pushLog('err', 'price: enter a market hash name')
      return
    }
    try {
      const { providers } = await api<{ providers: ItemPrice[] }>(`/api/price?hash=${encodeURIComponent(hash)}`)
      setPrices((prev) => ({ ...prev, [hash]: providers }))
      const line = providers.map((p) => `${p.provider}=${formatEuro(p.lowest_cents)}${p.error ? `(${p.error})` : ''}`).join(' | ')
      pushLog('ok', `Price ${hash}: ${line}`)
    } catch (err) {
      pushLog('err', `price: ${(err as Error).message}`)
    }
  }

  async function doSell(item: InventoryItem) {
    const priceCents = eurosToCents(sellPrices[item.assetid] ?? '')
    if (priceCents == null) {
      pushLog('err', `sell ${item.name}: enter a positive price in euros (e.g. 12,50)`)
      return
    }
    try {
      const r = await api<{ success: boolean; needs_mobile_confirmation: boolean; message?: string }>('/api/sell', {
        method: 'POST',
        body: JSON.stringify({ assetid: item.assetid, price: priceCents }),
      })
      const state = r.needs_mobile_confirmation ? 'needs your confirmation in Steam Mobile' : r.success ? 'listed' : 'failed'
      pushLog(r.success ? 'ok' : 'err', `sell ${item.name} @ ${formatEuro(priceCents)}: ${state}${r.message ? ` (${r.message})` : ''}`)
    } catch (err) {
      pushLog('err', `sell ${item.name}: ${(err as Error).message}`)
    }
  }

  async function doCancel(listing: ListingRow) {
    try {
      const r = await api<{ success: boolean }>('/api/cancel', { method: 'POST', body: JSON.stringify({ listingid: listing.listingid }) })
      pushLog(r.success ? 'ok' : 'err', `cancel ${listing.listingid}: ${r.success ? 'done' : 'failed'}`)
      await loadListings()
    } catch (err) {
      pushLog('err', `cancel: ${(err as Error).message}`)
    }
  }

  function marketIcon(item: InventoryItem): string {
    if (!item.icon_url) return ''
    return `https://community.cloudflare.steamstatic.com/economy/image/${item.icon_url}`
  }

  const sellable = inventory.filter((item) => item.marketable)

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
        <button onClick={() => void loadInventory()} disabled={!status?.loggedIn}>
          Load inventory
        </button>
        {!status?.loggedIn && (
          <span className="inline">
            <input
              placeholder="Your profile URL or steamid64 (public inventory)"
              value={profileInput}
              onChange={(e) => setProfileInput(e.target.value)}
            />
            <button onClick={() => void loadPublicInventory()} disabled={!profileInput.trim()}>
              Load public inventory
            </button>
          </span>
        )}
        <button onClick={() => void loadListings()} disabled={!status?.loggedIn}>
          My listings
        </button>
        <div className="pricebar">
          <input placeholder="Market hash name, e.g. AK-47 | Redline (Field-Tested)" value={priceHash} onChange={(e) => setPriceHash(e.target.value)} />
          <button onClick={() => void fetchPrice()}>Compare prices</button>
        </div>
      </section>

      <section className="card inventory">
        <h2>Inventory ({sellable.length})</h2>
        {sellable.length === 0 && <p className="muted">Load your inventory to start. Prices are in euros.</p>}
        <ul className="rows">
          {sellable.map((item) => (
            <li key={item.assetid} className="row">
              <img className="icon" src={marketIcon(item)} alt="" loading="lazy" />
              <div className="meta">
                <div className="name">{item.name}</div>
                <div className="sub">{item.market_hash_name}</div>
              </div>
              <span className={`badge ${item.marketable ? 'ok' : 'muted'}`}>{item.marketable ? 'marketable' : item.marketable_restriction ? `not yet (${item.marketable_restriction}d)` : 'not marketable'}</span>
              <div className="prices">
                {prices[item.market_hash_name]?.map((p) => (
                  <span key={p.provider} className={p.error ? 'muted' : ''} title={p.error}>
                    {p.provider} {formatEuro(p.lowest_cents)}
                  </span>
                ))}
              </div>
              <input
                placeholder="price €"
                value={sellPrices[item.assetid] ?? ''}
                onChange={(e) => setSellPrices((prev) => ({ ...prev, [item.assetid]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doSell(item)
                }}
              />
              <button onClick={() => void doSell(item)} disabled={!item.marketable}>
                Sell
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="card listings">
        <h2>My listings</h2>
        {listings.length === 0 && <p className="muted">No listings loaded.</p>}
        <ul className="rows">
          {listings.map((l) => (
            <li key={l.listingid} className="row">
              <img
                className="icon"
                src={l.icon_url ? `https://community.cloudflare.steamstatic.com/economy/image/${l.icon_url}` : ''}
                alt=""
                loading="lazy"
              />
              <div className="meta">
                <div className="name">{l.name ?? l.market_hash_name ?? l.assetid ?? 'Unknown item'}</div>
                <div className="sub">{l.market_hash_name ?? l.assetid ?? l.listingid}</div>
              </div>
              <span className={`badge ${l.marketable === false ? 'muted' : 'ok'}`}>
                {l.marketable === false
                  ? l.marketable_restriction
                    ? `not yet (${l.marketable_restriction}d)`
                    : 'not marketable'
                  : 'marketable'}
              </span>
              <span className="price">{formatEuro(l.price_cents)}</span>
              <button onClick={() => void doCancel(l)}>Cancel</button>
            </li>
          ))}
        </ul>
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