import express from 'express'
import { existsSync } from 'node:fs'
import path from 'node:path'
import './db'
import * as steam from './steam'
import { comparePrices } from './price'
import { listItems } from './db'
import { clearPendingSell, forgetListing, markPendingSell, refreshListings } from './listings'
import { buildGrid, startAutoSync, sync } from './sync'
import { buildCompare } from './compare'

const app = express()
app.use(express.json())

startAutoSync()

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: '0.1.0' })
})

app.get('/api/auth/status', async (_req, res) => {
  // Re-probe only when the cached result is stale, so polling status never
  // hammers Steam while a dead session still auto-resolves.
  await steam.ensureSessionProbe()
  res.json(steam.authStatus())
})

app.post('/api/auth/login', async (req, res) => {
  const { accountName, password } = req.body as { accountName?: string; password?: string }
  if (!accountName || !password) {
    res.status(400).json({ error: 'accountName and password are required' })
    return
  }
  try {
    const step = await steam.login(accountName, password)
    if (step.status === 'ok') {
      res.json({ loggedIn: true, steamid: step.steamid })
      return
    }
    if (step.guard === 'approval') {
      res.json({ needsApproval: true })
      return
    }
    res.json({ needsCode: true, guard: step.guard, emaildomain: step.emaildomain })
  } catch (err) {
    res.status(401).json({ error: (err as Error).message })
  }
})

app.post('/api/auth/guard', async (req, res) => {
  const { code } = req.body as { code?: string }
  if (!code) {
    res.status(400).json({ error: 'code is required' })
    return
  }
  try {
    res.json(await steam.submitGuardCode(code.trim()))
  } catch (err) {
    res.status(401).json({ error: (err as Error).message })
  }
})

app.post('/api/auth/logout', (_req, res) => {
  res.json(steam.logout())
})

app.get('/api/inventory', async (req, res) => {
  const steamid = typeof req.query.steamid === 'string' ? req.query.steamid : undefined
  try {
    res.json(steamid ? await steam.getPublicInventory(steamid) : await steam.getInventory())
  } catch (err) {
    res.status(401).json({ error: (err as Error).message })
  }
})

app.get('/api/steamid', async (req, res) => {
  const input = typeof req.query.input === 'string' ? req.query.input : ''
  if (!input) {
    res.status(400).json({ error: 'input query param is required' })
    return
  }
  try {
    res.json({ steamid64: await steam.resolveSteamID64(input) })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

app.get('/api/items', (_req, res) => {
  res.json({ items: listItems() })
})

app.get('/api/grid', (_req, res) => {
  res.json(buildGrid())
})

app.get('/api/compare', (req, res) => {
  const hash = typeof req.query.hash === 'string' ? req.query.hash : ''
  if (!hash) {
    res.status(400).json({ error: 'hash query param is required' })
    return
  }
  res.json({ compare: buildCompare(hash) })
})

app.post('/api/sync', async (_req, res) => {
  const started = await sync.syncAll()
  res.json({ started, sync: sync.status() })
})

app.get('/api/sync/status', (_req, res) => {
  res.json(sync.status())
})

app.get('/api/mylistings', async (_req, res) => {
  try {
    res.json(await steam.getMyListings())
  } catch (err) {
    res.status(401).json({ error: (err as Error).message })
  }
})

app.get('/api/price', async (req, res) => {
  const hash = typeof req.query.hash === 'string' ? req.query.hash : ''
  if (!hash) {
    res.status(400).json({ error: 'hash query param is required' })
    return
  }
  try {
    res.json({ hash, providers: await comparePrices(hash) })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/sell', async (req, res) => {
  const { assetid, contextid, price } = req.body as { assetid?: string; contextid?: string; price?: number }
  if (!assetid || typeof price !== 'number' || price <= 0) {
    res.status(400).json({ error: 'assetid and price (in cents) are required' })
    return
  }
  // A retried sell supersedes any earlier attempt for the same asset, so drop
  // the stale pending row before asking Steam again.
  clearPendingSell(assetid)
  let result: steam.SellResult
  try {
    result = await steam.sellItem(assetid, price, contextid && contextid !== '2' ? contextid : undefined)
  } catch (err) {
    res.status(401).json({ error: (err as Error).message })
    return
  }
  if (!result.success) {
    res.json(result)
    return
  }
  // Steam accepted the sell but will not list it until you approve it in the
  // Steam Mobile app. Remember that so the grid can say "awaiting approval"
  // instead of offering to sell an item that is already committed, and start
  // watching for it to become a listing (or be rejected).
  const item = listItems().find((i) => i.assetid === assetid)
  markPendingSell({ assetid, market_hash_name: item?.market_hash_name ?? null, price_cents: price })
  if (!result.needs_mobile_confirmation) {
    // Steam listed it outright, so the listing should already exist — confirm
    // immediately instead of waiting out the backoff.
void refreshListings().catch((err) => console.warn('[listings] post-cancel refresh failed:', err.message))
  }
  res.json({ ...result, pending: true })
})

app.post('/api/cancel', async (req, res) => {
  const { listingid } = req.body as { listingid?: string }
  if (!listingid) {
    res.status(400).json({ error: 'listingid is required' })
    return
  }
  let result: { success: boolean }
  try {
    result = await steam.cancelListing(listingid)
  } catch (err) {
    res.status(401).json({ error: (err as Error).message })
    return
  }
  if (!result.success) {
    res.json(result)
    return
  }
  // Stop showing it as listed straight away rather than after the next sync,
  // then reconcile against Steam to confirm it really is gone.
  forgetListing(listingid)
  void refreshListings()
  // The asset is back in the active inventory, but our cached row still says
  // context 16 / marketable=0, which would drop it out of the grid until the
  // next full sync. Re-read both contexts so it comes back immediately.
  void steam
    .refreshInventoryContexts()
    .then(() => undefined)
    .catch((err: Error) => console.warn('[inventory] post-cancel context refresh failed:', err.message))
  res.json(result)
})

const distDir = path.resolve(process.cwd(), 'dist')
app.use(express.static(distDir))
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    next()
    return
  }
  const index = path.join(distDir, 'index.html')
  if (existsSync(index)) {
    res.sendFile(index)
    return
  }
  next()
})

const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '127.0.0.1'

app.listen(port, host, () => {
  if (existsSync(path.join(distDir, 'index.html'))) {
    console.info(`[skin-hq] http://${host}:${port} (client + API)`)
  } else {
    console.info(`[skin-hq] API on http://${host}:${port}; client runs via \`npm run dev:client\``)
  }
})