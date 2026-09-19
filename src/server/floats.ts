import { decodeLink } from '@csfloat/cs2-inspect-serializer'

export interface AssetProperty {
  propertyid?: number
  int_value?: string
  float_value?: string
  string_value?: string
  name?: string
}

export interface AssetPropertyEntry {
  appid?: number
  contextid?: string
  assetid: string
  asset_properties?: AssetProperty[]
}

export interface OwnSticker {
  slot: number
  stickerId: number
  wear?: number
}

export interface OwnKeychain {
  slot: number
  stickerId: number
  pattern?: number
  wear?: number
}

export interface OwnItemFloat {
  assetid: string
  float_value: number
  paint_seed: number
  paint_index: number | null
  stickers: OwnSticker[]
  keychains: OwnKeychain[]
}

export const PROP_PATTERN = 1
export const PROP_WEAR = 2
export const PROP_INSPECT = 6

export function ownInspectLink(hex: string): string {
  return `steam://run/730//+csgo_econ_action_preview%20${hex}`
}

/**
 * Steam's CS2 inventory JSON exposes per-asset "asset_properties":
 *   propertyid 1 = Pattern Template (paint seed), 2 = Wear Rating (float),
 *   6 = Item Certificate (the self-encoded inspect-link hex, the source of
 *   truth since Steam stopped serving the classic S/A/D inspect links).
 * Decodes the hex with the official serializer so stickers/keychains come
 * along for free; falls back to the raw property values when the hex is
 * missing or unparseable.
 */
export function inspectFromProperties(entry: AssetPropertyEntry): OwnItemFloat | null {
  const props = entry.asset_properties ?? []
  const byId = new Map<number, AssetProperty>()
  for (const p of props) if (p.propertyid != null) byId.set(p.propertyid, p)

  const hex = byId.get(PROP_INSPECT)?.string_value
  if (hex) {
    try {
      const decoded = decodeLink(ownInspectLink(hex))
      return {
        assetid: entry.assetid,
        float_value: decoded.paintwear ?? 0,
        paint_seed: decoded.paintseed ?? 0,
        paint_index: decoded.paintindex ?? null,
        stickers: (decoded.stickers ?? []).map((s) => ({ slot: s.slot ?? 0, stickerId: s.stickerId ?? 0, wear: s.wear })),
        keychains: (decoded.keychains ?? []).map((k) => ({ slot: k.slot ?? 0, stickerId: k.stickerId ?? 0, pattern: k.pattern ?? 0, wear: k.wear })),
      }
    } catch {
      /* fall through to the raw property values below */
    }
  }

  const floatRaw = byId.get(PROP_WEAR)?.float_value
  if (floatRaw == null) return null
  const floatValue = Number(floatRaw)
  if (!Number.isFinite(floatValue)) return null
  const seedRaw = byId.get(PROP_PATTERN)?.int_value
  return {
    assetid: entry.assetid,
    float_value: floatValue,
    paint_seed: seedRaw != null ? Number(seedRaw) : 0,
    paint_index: null,
    stickers: [],
    keychains: [],
  }
}