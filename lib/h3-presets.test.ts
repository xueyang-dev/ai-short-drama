import { describe, expect, it } from 'vitest'
import { H3_PRESET_IDS, H3_PRESETS, h3ShotSettingsSchema } from './h3-presets'

const validSettings = {
  referenceImagePaths: ['data/media/reference.png'],
  prompt: 'A Saudi dramatic close-up',
  width: 768,
  height: 1280,
  duration: 5,
  seed: 42,
  model: 'MiniMax-H3/minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  presetId: 'fl2va-turbo-4' as const,
  turboMode: true,
}

describe('H3 presets', () => {
  it('defines the four versioned application presets', () => {
    expect(Object.keys(H3_PRESETS)).toEqual(H3_PRESET_IDS)
    expect(H3_PRESETS['fl2va-turbo-4'].steps).toBe(4)
    expect(H3_PRESETS['fl2va-turbo-8'].steps).toBe(8)
    expect(H3_PRESETS.ref2va.modelFamily).toBe('ref2va')
  })

  it('accepts valid shot settings', () => {
    expect(h3ShotSettingsSchema.parse(validSettings)).toEqual(validSettings)
  })

  it('rejects dimensions that ComfyUI cannot align', () => {
    const result = h3ShotSettingsSchema.safeParse({ ...validSettings, width: 777 })
    expect(result.success).toBe(false)
  })

  it('rejects a turbo flag that conflicts with its preset', () => {
    const result = h3ShotSettingsSchema.safeParse({ ...validSettings, turboMode: false })
    expect(result.success).toBe(false)
  })

  it('treats PinkCherry as an FL2VA checkpoint variant', () => {
    const result = h3ShotSettingsSchema.safeParse({
      ...validSettings,
      model: 'MiniMax-H3/PinkCherry_fl2va_MiniMax_H3_pruned_int8_convrot-beta-0.6.safetensors',
    })
    expect(result.success).toBe(true)
  })
})
