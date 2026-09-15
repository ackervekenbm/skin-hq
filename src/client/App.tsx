import { useCallback, useEffect, useState } from 'react'

interface AuthStatus {
  loggedIn: boolean
  steamid: string | null
}

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
  kind: 'ok' | 'err'
  text: string
}

function formatCents(cents: number | null | undefined): string {
  if (cents == null) return '—'
  return (cents / 100).toFixed(2)
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
  const [inventory, setInventory] = useState<InventoryItem[]>([])
  const [listings, setListings] = useState<ListingRow[]>([])
  const [prices, setPrices] = useState<Record<string, ItemPrice[]>>({})
  const [priceHash, setPriceHash] = useState('')
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
      const s = await api<AuthStatus>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ accountName, password, twoFactorCode: twoFactorCode || undefined }),
      })
      setStatus(s)
      setPassword('')
      setTwoFactorCode('')
      pushLog('ok', `Logged in as ${accountName}`)
    } catch (err) {
      pushLog('err', `login: ${(err as Error).message}`)
    }
  }

  async function doLogout() {
    await api('/api/auth/logout', { method: 'POST' })
    setStatus({ loggedIn: false, steamid: null })
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
      const line = providers.map((p) => `${p.provider}=${formatCents(p.lowest_cents)}${p.error ? `(${p.error})` : ''}`).join(' | ')
      pushLog('ok', `Price ${hash}: ${line}`)
    } catch (err) {
      pushLog('err', `price: ${(err as Error).message}`)
    }
  }

  async function doSell(item: InventoryItem) {
    const priceCents = parseInt(sellPrices[item.assetid] ?? '', 10)
    if (!Number.isFinite(priceCents) || priceCents <= 0) {
      pushLog('err', `sell ${item.name}: price must be a positive amount in cents`)
      return
    }
    try {
      const r = await api<{ success: boolean; needs_mobile_confirmation: boolean; message?: string }>('/api/sell', {
        method: 'POST',
        body: JSON.stringify({ assetid: item.assetid, price: priceCents }),
      })
      const state = r.needs_mobile_confirmation ? 'needs your confirmation in Steam Mobile' : r.success ? 'listed' : 'failed'
      pushLog(r.success ? 'ok' : 'err', `sell ${item.name} @ ${formatCents(priceCents)}: ${state}${r.message ? ` (${r.message})` : ''}`)
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

  return (
    <div className="app">
      <header>
        <h1>SkinHQ</h1>
        <span className="build">spike · {status?.loggedIn ? `signed in as ${status.steamid}` : 'not signed in to Steam'}</span>
      </header>

      <section className="card auth">
        <input placeholder="Steam account name" value={accountName} onChange={(e) => setAccountName(e.target.value)} />
        <input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <input placeholder="Steam Guard code (mobile)" value={twoFactorCode} onChange={(e) => setTwoFactorCode(e.target.value)} />
        {status?.loggedIn ? (
          <button onClick={() => void doLogout()}>Log out</button>
        ) : (
          <button onClick={() => void doLogin()} disabled={!accountName || !password}>
            Sign in
          </button>
        )}
      </section>

      <section className="card actions">
        <button onClick={() => void loadInventory()} disabled={!status?.loggedIn}>
          Load inventory
        </button>
        <button onClick={() => void loadListings()} disabled={!status?.loggedIn}>
          My listings
        </button>
        <div className="pricebar">
          <input placeholder="Market hash name, e.g. AK-47 | Redline (Field-Tested)" value={priceHash} onChange={(e) => setPriceHash(e.target.value)} />
          <button onClick={() => void fetchPrice()}>Compare prices</button>
        </div>
      </section>

      <section className="card inventory">
        <h2>Inventory ({inventory.length})</h2>
        {inventory.length === 0 && <p className="muted">Load your inventory to start. Sell prices below are in cents.</p>}
        <ul className="rows">
          {inventory.map((item) => (
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
                    {p.provider} {formatCents(p.lowest_cents)}
                  </span>
                ))}
              </div>
              <input
                placeholder="price ¢"
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
        <ul className="rows narrow">
          {listings.map((l) => (
            <li key={l.listingid} className="row">
              <span className="mono">{l.listingid}</span>
              <span className="mono">{l.assetid ?? '—'}</span>
              <span>{formatCents(l.price_cents)}</span>
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