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
  `)

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