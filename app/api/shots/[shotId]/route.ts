import { z } from 'zod'
import { deleteShot, getShot, updateShot } from '@/lib/db'
import { fail, ok } from '@/lib/api'
import { H3_PRESET_IDS, H3_PRESETS } from '@/lib/h3-presets'

const updateSchema = z.object({
  prompt: z.string().max(20_000).optional(),
  dialogue: z.string().max(10_000).optional(),
  duration: z.number().min(0.2).max(30).optional(),
  referenceImagePath: z.string().min(1).refine(
    value => !value.includes('..') && !/^[\\/]|^[a-zA-Z]:/.test(value),
    'referenceImagePath must be a relative media path',
  ).nullable().optional(),
  referenceEntityIds: z.array(z.string().uuid()).max(9).optional(),
  width: z.number().int().min(256).max(2048).refine(value => value % 32 === 0).optional(),
  height: z.number().int().min(256).max(2048).refine(value => value % 32 === 0).optional(),
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  videoProvider: z.literal('local-comfyui').optional(),
  h3Model: z.string().min(1).max(500).optional(),
  h3Preset: z.enum(H3_PRESET_IDS).optional(),
  turboMode: z.boolean().optional(),
  selectedVideoId: z.string().uuid().optional(),
}).superRefine((fields, context) => {
  if (!fields.h3Preset || fields.turboMode === undefined) return
  if (H3_PRESETS[fields.h3Preset].turboMode !== fields.turboMode) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['turboMode'],
      message: `turboMode must match preset ${fields.h3Preset}`,
    })
  }
})

export async function PATCH(request: Request, { params }: { params: Promise<{ shotId: string }> }) {
  try {
    const { shotId } = await params
    const current = getShot(shotId)
    if (!current) return fail('分镜不存在', 404)
    const fields = updateSchema.parse(await request.json())
    const preset = fields.h3Preset ?? current.h3Preset
    const turboMode = fields.turboMode ?? current.turboMode
    if (H3_PRESETS[preset].turboMode !== turboMode) {
      return fail(`turboMode must match preset ${preset}`, 400)
    }
    const shot = updateShot(shotId, fields)
    return shot ? ok(shot) : fail('分镜或视频版本不存在', 404)
  } catch (error) {
    return fail(error, error instanceof z.ZodError ? 400 : 500)
  }
}

export async function DELETE(_: Request, { params }: { params: Promise<{ shotId: string }> }) {
  try {
    const { shotId } = await params
    const shot = getShot(shotId)
    if (!shot) return fail('分镜不存在', 404)
    if (shot.status === 'generating') return fail('分镜视频正在生成，完成后才能删除镜头', 409)
    return deleteShot(shotId) ? ok({ deleted: true }) : fail('分镜不存在', 404)
  } catch (error) {
    return fail(error, error instanceof Error && error.message.includes('正在生成') ? 409 : 500)
  }
}
