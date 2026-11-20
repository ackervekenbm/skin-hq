import express from 'express'
import { existsSync } from 'node:fs'
import path from 'node:path'
import './db'
import * as steam from './steam'
import { listItems } from './db'
import { forgetListing, refreshListings } from './listings'
import { relist, sellAndTrack } from './selling'
import { buildGrid, refreshItemPrices, refreshRefusal, startAutoSync, sync } from './sync'
import { buildCompare } from './compare'
import { isAllowedHost, isCrossSiteWrite, isSteamId, parseAllowedHosts } from './guard'

const app = express()
const allowedHosts = parseAllowedHosts(process.env.SKINHQ_ALLOWED_HOSTS)
app.use((req, res, next) => {
  if (!isAllowedHost(req.get('host'), allowedHosts)) {
    res.status(421).type('text').send('Unknown host name. Add it to SKINHQ_ALLOWED_HOSTS to open SkinHQ through it.')
    return
  }
  next()
})
app.use('/api', (req, res, next) => {
  if (isCrossSiteWrite(req.method, (name) => req.get(name))) {
    res.status(403).json({ error: 'Cross-site or non-JSON write refused' })
    return
  }
  next()
})
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

app.get('/api/inventory', async (_req, res) => {
  try {
    res.json(await steam.getInventory())
  } catch (err) {
    res.status(401).json({ error: (err as Error).message })
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

// Fresh prices for one item, on demand, stored like a sync would store them.
// Only items in your inventory: this must not become a way to make the server
// fetch arbitrary market pages.
app.post('/api/price/refresh', async (req, res) => {
  const { hash } = req.body as { hash?: unknown }
  if (typeof hash !== 'string' || !hash) {
    res.status(400).json({ error: 'hash is required' })
    return
  }
  if (!listItems().some((i) => i.market_hash_name === hash)) {
    res.status(404).json({ error: 'not in your inventory' })
    return
  }
  const refusal = refreshRefusal(hash)
  if (refusal) {
    res.status(429).json({ error: refusal })
    return
  }
  const errors = await refreshItemPrices(hash)
  res.json({ compare: buildCompare(hash), errors })
})

app.post('/api/sell', async (req, res) => {
  const { assetid, contextid, price } = req.body as { assetid?: unknown; contextid?: unknown; price?: unknown }
  if (!isSteamId(assetid) || (contextid != null && !isSteamId(contextid)) || typeof price !== 'number' || !Number.isInteger(price) || price <= 0) {
    res.status(400).json({ error: 'assetid and a whole, positive price in cents are required' })
    return
  }
  let result: steam.SellResult
  try {
    result = await sellAndTrack(assetid, contextid ?? undefined, price)
  } catch (err) {
    res.status(401).json({ error: (err as Error).message })
    return
  }
  res.json(result.success ? { ...result, pending: true } : result)
})

app.post('/api/relist', async (req, res) => {
  const { listingid, assetid, price } = req.body as { listingid?: unknown; assetid?: unknown; price?: unknown }
  if (!isSteamId(listingid) || !isSteamId(assetid) || typeof price !== 'number' || !Number.isInteger(price) || price <= 0) {
    res.status(400).json({ error: 'listingid, assetid and a whole, positive price in cents are required' })
    return
  }
  try {
    res.json(await relist(listingid, assetid, price))
  } catch (err) {
    // Only the cancel can throw here (no session), so nothing changed.
    res.status(401).json({ error: (err as Error).message })
  }
})

app.post('/api/cancel', async (req, res) => {
  const { listingid } = req.body as { listingid?: unknown }
  // Goes into the removelisting/<id>/ URL path, so digits only.
  if (!isSteamId(listingid)) {
    res.status(400).json({ error: 'a numeric listingid is required' })
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