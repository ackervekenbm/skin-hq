import { describe, expect, it } from 'vitest'
import { attachedFromDescriptions, inspectFromProperties, ownInspectLink, type AssetPropertyEntry } from '../src/server/floats'

// Real payload observed from Steam's CS2 inventory JSON for a logged-in
// account: asset_properties carry the pattern template (1), wear rating (2)
// and the item certificate hex (6) that self-encodes the inspect link.
const MP5_AGENT_ENTRY: AssetPropertyEntry = {
  appid: 730,
  contextid: '2',
  assetid: '53815383860',
  asset_properties: [
    { propertyid: 1, int_value: '332', name: 'Pattern Template' },
    { propertyid: 2, float_value: '0.272527575492858887', name: 'Wear Rating' },
    { propertyid: 6, string_value: '88983C261E354089909FA87281A089B88CB03419267C8BC8448AE09EF890B9EB1FF4', name: 'Item Certificate' },
  ],
}

describe('inspectFromProperties', () => {
  it('decodes the item certificate into exact float, seed and stickers', () => {
    const info = inspectFromProperties(MP5_AGENT_ENTRY)
    expect(info).not.toBeNull()
    expect(info!.assetid).toBe('53815383860')
    expect(info!.float_value).toBeCloseTo(0.2725275754928589, 12)
    expect(info!.paint_seed).toBe(332)
    expect(info!.paint_index).toBe(1274)
    expect(info!.stickers).toEqual([])
    expect(info!.keychains).toEqual([])
  })

  it('falls back to the raw wear/pattern property values when the hex is missing', () => {
    const entry: AssetPropertyEntry = {
      assetid: 'x',
      asset_properties: [
        { propertyid: 2, float_value: '0.12345678', name: 'Wear Rating' },
        { propertyid: 1, int_value: '7', name: 'Pattern Template' },
      ],
    }
    expect(inspectFromProperties(entry)).toEqual({
      assetid: 'x',
      float_value: 0.12345678,
      paint_seed: 7,
      paint_index: null,
      stickers: [],
      keychains: [],
    })
  })

  it('returns null when the item has no float data at all', () => {
    expect(inspectFromProperties({ assetid: 'y', asset_properties: [] })).toBeNull()
    expect(
      inspectFromProperties({
        assetid: 'z',
        asset_properties: [{ propertyid: 2, float_value: 'nope' }],
      }),
    ).toBeNull()
  })
})

describe('ownInspectLink', () => {
  it('builds the steam://run preview link the serializer expects', () => {
    expect(ownInspectLink('ABCDEF')).toBe('steam://run/730//+csgo_econ_action_preview%20ABCDEF')
  })
})

// Real description text observed on an item with one applied sticker and a
// mounted charm: each label appears twice per block (img title + text node).
const STICKER_CHARM_DESC = [
  { type: 'html', value: 'Exterior: Field-Tested' },
  {
    type: 'html',
    value:
      '<br><div id="sticker_info" class="sticker_info" style="..."><center><img width=64 height=48 src="https://cdn.steamstatic.com/apps/730/icons/econ/stickers/community/sticker_craft/paper_ct_left_hand.91b1beab7e5c986c9961bf6712400eccc89ec02b.png" title="Sticker: Lefty (CT)"><br>Sticker: Lefty (CT)</center></div>',
  },
  {
    type: 'html',
    value:
      '<br><div id="keychain_info" class="keychain_info" style="..."><center><img width=64 height=48 src="https://cdn.steamstatic.com/apps/730/icons/econ/keychains/drboom/kc_db_terror.79493deaf354ac51f059600aeb3b6eca98c8b60d.png" title="Charm: Gritty"><br>Charm: Gritty</center></div>',
  },
]

describe('attachedFromDescriptions', () => {
  it('extracts sticker name+image and the charm name+image from the description blocks', () => {
    expect(attachedFromDescriptions(STICKER_CHARM_DESC)).toEqual({
      stickers: [
        {
          name: 'Lefty (CT)',
          image: 'https://cdn.steamstatic.com/apps/730/icons/econ/stickers/community/sticker_craft/paper_ct_left_hand.91b1beab7e5c986c9961bf6712400eccc89ec02b.png',
        },
      ],
      keychain: {
        name: 'Gritty',
        image: 'https://cdn.steamstatic.com/apps/730/icons/econ/keychains/drboom/kc_db_terror.79493deaf354ac51f059600aeb3b6eca98c8b60d.png',
      },
    })
  })

  it('extracts multiple sticker name+image pairs in order', () => {
    const twoStickers = [
      {
        type: 'html',
        value: '<div id="sticker_info"><img src="https://cdn.example.com/a.png" title="Sticker: Hope"><br>Sticker: Hope</center></div>',
      },
      {
        type: 'html',
        value: '<div id="sticker_info"><img src="https://cdn.example.com/b.png" title="Sticker: Wildfire"><br>Sticker: Wildfire</center></div>',
      },
    ]
    expect(attachedFromDescriptions(twoStickers).stickers).toEqual([
      { name: 'Hope', image: 'https://cdn.example.com/a.png' },
      { name: 'Wildfire', image: 'https://cdn.example.com/b.png' },
    ])
  })

  it('handles empty input and block-less text', () => {
    expect(attachedFromDescriptions(undefined)).toEqual({ stickers: [], keychain: null })
    expect(attachedFromDescriptions([`<br>Sticker: Lights Out</center>`]).stickers).toEqual([])
    expect(
      attachedFromDescriptions([`<div id="sticker_info"><center><br>Sticker: Lights Out</center></div>`]).stickers.map(
        (s) => s.name,
      ),
    ).toEqual(['Lights Out'])
  })

  it('captures names with special characters like & from the text node', () => {
    expect(
      attachedFromDescriptions([`<div id="sticker_info"><center><br>Sticker: Sparkle & Chill</center></div>`]).stickers,
    ).toEqual([{ name: 'Sparkle & Chill', image: null }])
  })
})