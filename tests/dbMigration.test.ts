import Database from 'better-sqlite3'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// A database from before the float/liquidity columns existed: what an early
// install has on disk. db.ts must upgrade it in place on start, keep its rows,
// and survive starting again on the upgraded file.
const dir = vi.hoisted(
  () => `${process.env.TMPDIR?.replace(/\/$/, '') ?? '/tmp'}/skinhq-migrate-${process.pid}-${Math.random().toString(36).slice(2)}`,
)
process.env.DATA_DIR = dir
process.env.SKINHQ_SESSION_KEY = 'test-key-for-migration-tests'

mkdirSync(dir, { recursive: true })
const old = new Database(path.join(dir, 'skin-hq.db'))
old.exec(`
  CREATE TABLE items (
    assetid TEXT PRIMARY KEY, appid INTEGER NOT NULL, contextid TEXT NOT NULL,
    market_hash_name TEXT NOT NULL, name TEXT, type TEXT, icon_url TEXT,
    tradable INTEGER NOT NULL, marketable INTEGER NOT NULL, raw TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE price_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, market_hash_name TEXT NOT NULL, provider TEXT NOT NULL,
    lowest_cents INTEGER, median_cents INTEGER, volume INTEGER, sell_count INTEGER, buy_count INTEGER,
    had_error INTEGER NOT NULL DEFAULT 0, note TEXT, fetched_at TEXT NOT NULL
  );
  INSERT INTO items VALUES ('A1', 730, '2', 'AK-47 | Vulcan (Field-Tested)', 'AK-47 | Vulcan', 'Rifle', 'icon', 1, 1, '{}', '2026-01-01T00:00:00Z');
  INSERT INTO price_snapshots (market_hash_name, provider, lowest_cents, fetched_at) VALUES ('AK-47 | Vulcan (Field-Tested)', 'steam', 1250, '2026-01-01T00:00:00Z');
`)
old.close()

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const columns = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)

describe('opening an old database', () => {
  it('adds the missing columns and keeps every row', async () => {
    const { db, getItem, latestPriceSnapshots } = await import('../src/server/db')
    expect(columns(db, 'items')).toEqual(expect.arrayContaining(['own_float', 'own_seed', 'own_stickers']))
    expect(columns(db, 'price_snapshots')).toEqual(expect.arrayContaining(['highest_buy_cents', 'float_value', 'paint_seed', 'stickers']))
    expect(getItem('A1')).toMatchObject({ market_hash_name: 'AK-47 | Vulcan (Field-Tested)', own_float: null })
    expect(latestPriceSnapshots().byItem.get('AK-47 | Vulcan (Field-Tested)')?.get('steam')?.lowest_cents).toBe(1250)
    // The tables that came later exist too.
    expect(columns(db, 'pending_listings')).toContain('state')
    expect(columns(db, 'my_listings')).toContain('listingid')
  })

  it('accepts floats on the upgraded rows', async () => {
    const { getItem, upsertItems } = await import('../src/server/db')
    const row = getItem('A1')!
    upsertItems([{ ...row, own_float: 0.25, own_seed: 7, own_stickers: null }])
    expect(getItem('A1')).toMatchObject({ own_float: 0.25, own_seed: 7 })
  })

  it('starts again on the upgraded file without changing it', async () => {
    const first = await import('../src/server/db')
    const before = { items: columns(first.db, 'items'), snaps: columns(first.db, 'price_snapshots') }
    first.db.close()
    vi.resetModules()
    const second = await import('../src/server/db')
    expect(columns(second.db, 'items')).toEqual(before.items)
    expect(columns(second.db, 'price_snapshots')).toEqual(before.snaps)
    expect(second.getItem('A1')?.own_float).toBe(0.25)
  })
})
