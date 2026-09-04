import { z } from 'zod'

export const H3_PRESET_IDS = [
  'fl2va-base',
  'fl2va-turbo-4',
  'fl2va-turbo-8',
  'ref2va',
] as const

export type H3PresetId = (typeof H3_PRESET_IDS)[number]
export type H3ModelFamily = 'fl2va' | 'ref2va'

export interface H3Preset {
  id: H3PresetId
  label: string
  modelFamily: H3ModelFamily
  turboMode: boolean
  steps: number
  scheduler: 'beta'
  sampler: 'euler'
  loraFilename: string | null
}

export const H3_PRESETS: Record<H3PresetId, H3Preset> = {
  'fl2va-base': {
    id: 'fl2va-base',
    label: 'FL2VA Base',
    modelFamily: 'fl2va',
    turboMode: false,
    steps: 20,
    scheduler: 'beta',
    sampler: 'euler',
    loraFilename: null,
  },
  'fl2va-turbo-4': {
    id: 'fl2va-turbo-4',
    label: 'FL2VA Turbo 4',
    modelFamily: 'fl2va',
    turboMode: true,
    steps: 4,
    scheduler: 'beta',
    sampler: 'euler',
    loraFilename: 'MiniMax-H3/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors',
  },
  'fl2va-turbo-8': {
    id: 'fl2va-turbo-8',
    label: 'FL2VA Turbo 8',
    modelFamily: 'fl2va',
    turboMode: true,
    steps: 8,
    scheduler: 'beta',
    sampler: 'euler',
    loraFilename: 'MiniMax-H3/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
  },
  ref2va: {
    id: 'ref2va',
    label: 'REF2VA Base',
    modelFamily: 'ref2va',
    turboMode: false,
    steps: 20,
    scheduler: 'beta',
    sampler: 'euler',
    loraFilename: null,
  },
}

export const h3ShotSettingsSchema = z.object({
  referenceImagePaths: z.array(z.string().min(1)).min(1).max(9),
  prompt: z.string().trim().min(1),
  width: z.number().int().min(256).max(2048).refine((value) => value % 32 === 0),
  height: z.number().int().min(256).max(2048).refine((value) => value % 32 === 0),
  duration: z.number().min(0.2).max(30),
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  model: z.string().min(1),
  presetId: z.enum(H3_PRESET_IDS),
  turboMode: z.boolean(),
}).superRefine((settings, context) => {
  const preset = H3_PRESETS[settings.presetId]

  if (settings.turboMode !== preset.turboMode) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['turboMode'],
      message: `turboMode must match preset ${settings.presetId}`,
    })
  }

  const lowerModel = settings.model.toLowerCase()
  if (preset.modelFamily === 'ref2va' && !lowerModel.includes('ref2va')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['model'],
      message: 'REF2VA preset requires a REF2VA checkpoint',
    })
  }
  if (preset.modelFamily === 'fl2va' && lowerModel.includes('ref2va')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['model'],
      message: 'FL2VA preset requires an FL2VA-compatible checkpoint',
    })
  }
})

export type H3ShotSettings = z.infer<typeof h3ShotSettingsSchema>

export function getH3Preset(id: H3PresetId): H3Preset {
  return H3_PRESETS[id]
}
