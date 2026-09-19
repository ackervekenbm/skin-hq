import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { decryptSecret, encryptSecret } from './crypto'

const dataDir = path.resolve(process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data'))
mkdirSync(dataDir, { recursive: true })

export const db = new Database(path.join(dataDir, 'skin-hq.db'))
db.pragma('journal_mode = WAL')

db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      account_name TEXT NOT NULL,
      steamid TEXT NOT NULL,
      cookies_enc TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS items (
      assetid TEXT PRIMARY KEY,
      appid INTEGER NOT NULL,
      contextid TEXT NOT NULL,
      market_hash_name TEXT NOT NULL,
      name TEXT,
      type TEXT,
      icon_url TEXT,
      tradable INTEGER NOT NULL,
      marketable INTEGER NOT NULL,
      raw TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS price_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_hash_name TEXT NOT NULL,
      provider TEXT NOT NULL,
      lowest_cents INTEGER,
      median_cents INTEGER,
      volume INTEGER,
      sell_count INTEGER,
      buy_count INTEGER,
      highest_buy_cents INTEGER,
      float_value REAL,
      paint_seed INTEGER,
      stickers TEXT,
      had_error INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_price_snapshots_hash
      ON price_snapshots (market_hash_name, provider);
    CREATE TABLE IF NOT EXISTS my_listings (
      listingid TEXT PRIMARY KEY,
      assetid TEXT,
      market_hash_name TEXT,
      price_cents INTEGER,
      appid INTEGER NOT NULL DEFAULT 730,
      updated_at TEXT NOT NULL
    );
  `)

  // Migrations for pre-P1-B databases: add the liquidity/float columns that
  // the original price_snapshots table did not have. Idempotent.
  const cols = (db.prepare('PRAGMA table_info(price_snapshots)').all() as Array<{ name: string }>).map((c) => c.name)
  const addCol = (name: string, ddl: string): void => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE price_snapshots ADD COLUMN ${ddl}`)
  }
  addCol('highest_buy_cents', 'highest_buy_cents INTEGER')
  addCol('float_value', 'float_value REAL')
  addCol('paint_seed', 'paint_seed INTEGER')
  addCol('stickers', 'stickers TEXT')

export interface StoredSession {
  accountName: string
  steamid: string
  cookies: string[]
}

export function saveSession(session: StoredSession): void {
  db.prepare(
    `INSERT INTO sessions (id, account_name, steamid, cookies_enc, updated_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       account_name = excluded.account_name,
       steamid = excluded.steamid,
       cookies_enc = excluded.cookies_enc,
       updated_at = excluded.updated_at`,
  ).run(session.accountName, session.steamid, encryptSecret(JSON.stringify(session.cookies)), new Date().toISOString())
}

export function loadSession(): StoredSession | null {
  const row = db.prepare('SELECT account_name, steamid, cookies_enc FROM sessions WHERE id = 1').get() as
    | { account_name: string; steamid: string; cookies_enc: string }
    | undefined
  if (!row) return null
  return { accountName: row.account_name, steamid: row.steamid, cookies: JSON.parse(decryptSecret(row.cookies_enc)) }
}

export function clearSession(): void {
  db.prepare('DELETE FROM sessions WHERE id = 1').run()
}

export function upsertItems(items: ItemRow[]): void {
  const stmt = db.prepare(
    `INSERT INTO items (assetid, appid, contextid, market_hash_name, name, type, icon_url, tradable, marketable, raw, updated_at)
     VALUES (@assetid, @appid, @contextid, @market_hash_name, @name, @type, @icon_url, @tradable, @marketable, @raw, @updated_at)
     ON CONFLICT(assetid) DO UPDATE SET
       market_hash_name = excluded.market_hash_name,
       name = excluded.name,
       type = excluded.type,
       icon_url = excluded.icon_url,
       tradable = excluded.tradable,
       marketable = excluded.marketable,
       raw = excluded.raw,
       updated_at = excluded.updated_at`,
  )
  const tx = db.transaction((rows: ItemRow[]) => rows.forEach((r) => stmt.run(r)))
  tx(items)
}

export function listItems(): ItemRow[] {
  return db.prepare('SELECT * FROM items ORDER BY updated_at DESC').all() as ItemRow[]
}

export interface ItemRow {
  assetid: string
  appid: number
  contextid: string
  market_hash_name: string
  name: string | null
  type: string | null
  icon_url: string | null
  tradable: number
  marketable: number
  raw: string
  updated_at: string
}

export interface PriceSnapshotInput {
  market_hash_name: string
  provider: string
  lowest_cents?: number | null
  median_cents?: number | null
  volume?: number | null
  sell_count?: number | null
  buy_count?: number | null
  highest_buy_cents?: number | null
  float_value?: number | null
  paint_seed?: number | null
  stickers?: string | null
  had_error?: number
  note?: string | null
}

export interface PriceSnapshotRow extends PriceSnapshotInput {
  id: number
  fetched_at: string
}

export interface MyListingRow {
  listingid: string
  assetid: string
  market_hash_name: string
  price_cents: number | null
  updated_at: string
}

export function insertPriceSnapshot(input: PriceSnapshotInput): void {
  db.prepare(
    `INSERT INTO price_snapshots
       (market_hash_name, provider, lowest_cents, median_cents, volume, sell_count, buy_count, highest_buy_cents, float_value, paint_seed, stickers, had_error, note, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.market_hash_name,
    input.provider,
    input.lowest_cents ?? null,
    input.median_cents ?? null,
    input.volume ?? null,
    input.sell_count ?? null,
    input.buy_count ?? null,
    input.highest_buy_cents ?? null,
    input.float_value ?? null,
    input.paint_seed ?? null,
    input.stickers ?? null,
    input.had_error ?? 0,
    input.note ?? null,
    new Date().toISOString(),
  )
}

export function latestPriceSnapshots(): { byItem: Map<string, Map<string, PriceSnapshotRow>>; latestAt: string | null } {
  const rows = db
    .prepare(
      `SELECT market_hash_name, provider, lowest_cents, median_cents, volume, sell_count, buy_count, highest_buy_cents, float_value, paint_seed, stickers, had_error, note, fetched_at
       FROM price_snapshots snap
       WHERE fetched_at = (
         SELECT MAX(fetched_at) FROM price_snapshots
         WHERE market_hash_name = snap.market_hash_name AND provider = snap.provider
       )`,
    )
    .all() as Array<Omit<PriceSnapshotRow, 'id'>>

  const byItem = new Map<string, Map<string, PriceSnapshotRow>>()
  let latestAt: string | null = null
  for (const r of rows) {
    let providers = byItem.get(r.market_hash_name)
    if (!providers) {
      providers = new Map()
      byItem.set(r.market_hash_name, providers)
    }
    const row = { ...r, id: 0 }
    providers.set(r.provider, row)
    if (!latestAt || r.fetched_at > latestAt) latestAt = r.fetched_at
  }
  return { byItem, latestAt }
}

export function replaceMyListings(rows: MyListingRow[]): void {
  const tx = db.transaction((list: MyListingRow[]) => {
    db.prepare('DELETE FROM my_listings').run()
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO my_listings (listingid, assetid, market_hash_name, price_cents, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    for (const l of list) stmt.run(l.listingid, l.assetid, l.market_hash_name, l.price_cents, l.updated_at)
  })
  tx(rows)
}

export function listMyListings(): MyListingRow[] {
  return db.prepare('SELECT * FROM my_listings').all() as MyListingRow[]
}