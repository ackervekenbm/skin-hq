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
  name?: string | null
}

export interface OwnKeychain {
  slot: number
  stickerId: number
  pattern?: number
  wear?: number
  name?: string | null
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

/**
 * Steam's item descriptions carry per-sticker "Sticker: <name>" and (at most
 * one) "Charm: <name>" blocks rendered inside the sticker_info/keychain_info
 * HTML. Each label appears twice in the block (the img title attribute and the
 * text node), so we collect unique labels in order. The inspect decode only
 * yields ids + slots, so names are matched positionally — description order
 * matches Steam's slot order. Best-effort: use the numeric id when a name is
 * missing or has no description block.
 */
export function namesFromDescriptions(descriptions: Array<{ value?: unknown } | string> | null | undefined): {
  stickers: string[]
  keychain: string | null
} {
  const text = (descriptions ?? [])
    .map((d) => (typeof d === 'string' ? d : String(d.value ?? '')))
    .join('\n')

  const stickers: string[] = []
  const seen = new Set<string>()
  const re = /Sticker:\s*([^"<]{1,120})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const name = m[1].trim()
    if (name && !seen.has(name)) {
      seen.add(name)
      stickers.push(name)
    }
  }

  const charm = /Charm:\s*([^"<]{1,120})/.exec(text)
  return { stickers, keychain: charm ? charm[1].trim() : null }
}