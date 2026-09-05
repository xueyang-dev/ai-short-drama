import { z } from 'zod'
import {
  addShotVideo,
  getProjectBundle,
  getShot,
  markShotFailed,
  markShotGenerating,
  markShotSubmitting,
  updateShot,
} from '@/lib/db'
import { H3_PRESET_IDS, H3_PRESETS, h3ShotSettingsSchema } from '@/lib/h3-presets'
import { localComfyUIProvider, WORKFLOW_VERSION } from '@/lib/providers/comfyui'
import {
  bindStoryboardReferencesForH3,
  getStoryboardReferenceTag,
  resolveStoryboardReferenceEntities,
} from '@/lib/storyboard-references'
import { fail, ok } from '@/lib/api'

export const maxDuration = 600
export const dynamic = 'force-dynamic'

const createSchema = z.object({
  prompt: z.string().trim().min(1).max(20_000).optional(),
  width: z.number().int().min(256).max(2048).refine(value => value % 32 === 0).optional(),
  height: z.number().int().min(256).max(2048).refine(value => value % 32 === 0).optional(),
  duration: z.number().min(0.2).max(30).optional(),
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  model: z.string().min(1).max(500).optional(),
  presetId: z.enum(H3_PRESET_IDS).optional(),
  turboMode: z.boolean().optional(),
})

export async function POST(request: Request, { params }: { params: Promise<{ shotId: string }> }) {
  let submittingShotId: string | null = null
  try {
    const { shotId } = await params
    const body = createSchema.parse(await request.json())
    let shot = getShot(shotId)
    if (!shot) return fail('分镜不存在', 404)
    if (shot.status === 'generating') return fail('该分镜正在生成中', 409)
    const bundle = getProjectBundle(shot.projectId)!
    const episode = bundle.episodes.find(item => item.id === shot!.episodeId)
    if (episode?.status !== 'confirmed') return fail('请先定稿本集剧本，再生成分镜视频', 409)

    const presetId = body.presetId ?? shot.h3Preset
    shot = updateShot(shot.id, {
      prompt: body.prompt ?? shot.prompt,
      width: body.width ?? shot.width,
      height: body.height ?? shot.height,
      duration: body.duration ?? shot.duration,
      seed: body.seed ?? shot.seed,
      h3Model: body.model ?? shot.h3Model,
      h3Preset: presetId,
      turboMode: body.turboMode ?? H3_PRESETS[presetId].turboMode,
      videoProvider: 'local-comfyui',
    })!

    const selectedReferences = shot.referenceEntityIds
      .map(id => bundle.entities.find(entity => entity.id === id))
      .filter((entity): entity is NonNullable<typeof entity> => Boolean(entity))
    const missingImages = selectedReferences.filter(entity => !entity.selectedImage?.path)
    if (missingImages.length) {
      return fail(`请先上传并选定参考图：${missingImages.map(entity => entity.variant ? `${entity.name} / ${entity.variant}` : entity.name).join('、')}`, 400)
    }
    const promptReferences = resolveStoryboardReferenceEntities(shot.prompt, bundle.entities)
    const selectedIds = new Set(selectedReferences.map(entity => entity.id))
    const unselectedTags = promptReferences.filter(entity => !selectedIds.has(entity.id))
    if (unselectedTags.length) {
      return fail(`提示词引用了未选中的素材：${unselectedTags.map(getStoryboardReferenceTag).join('、')}`, 400)
    }

    const referenceImagePaths = selectedReferences.map(entity => entity.selectedImage!.path)
    if (shot.referenceImagePath && !referenceImagePaths.includes(shot.referenceImagePath)) {
      referenceImagePaths.push(shot.referenceImagePath)
    }
    if (!referenceImagePaths.length) return fail('请为镜头选择至少一张参考图', 400)
    const generation = h3ShotSettingsSchema.parse({
      referenceImagePaths,
      prompt: bindStoryboardReferencesForH3(shot.prompt, selectedReferences),
      width: shot.width,
      height: shot.height,
      duration: shot.duration,
      seed: shot.seed,
      model: shot.h3Model,
      presetId: shot.h3Preset,
      turboMode: shot.turboMode,
    })

    markShotSubmitting(shot.id)
    submittingShotId = shot.id
    const job = await localComfyUIProvider.submit(generation)
    return ok(markShotGenerating(
      shot.id,
      job.id,
      shot.h3Model,
      `${shot.width}x${shot.height}`,
      WORKFLOW_VERSION,
    ), { status: 202 })
  } catch (error) {
    if (submittingShotId && getShot(submittingShotId)?.status === 'generating') {
      markShotFailed(submittingShotId, error instanceof Error ? error.message : 'Local ComfyUI 任务提交失败')
    }
    const status = error instanceof z.ZodError
      ? 400
      : error instanceof Error && error.message.includes('已在生成中')
        ? 409
        : 500
    return fail(error, status)
  }
}

export async function GET(_: Request, { params }: { params: Promise<{ shotId: string }> }) {
  const { shotId } = await params
  try {
    let shot = getShot(shotId)
    if (!shot) return fail('分镜不存在', 404)
    if (shot.status === 'success' && shot.selectedVideo?.path) return ok(shot)
    if (!shot.providerTaskId) return ok(shot)

    const job = await localComfyUIProvider.getJob(shot.providerTaskId)
    if (job.state === 'failed' || job.state === 'cancelled') {
      return ok(markShotFailed(shot.id, job.error || `任务状态：${job.state}`))
    }
    if (job.state !== 'succeeded') return ok(shot)
    if (!job.output?.path) return ok(markShotFailed(shot.id, 'ComfyUI 任务成功但未返回视频'))

    shot = getShot(shot.id)!
    if (shot.status === 'success' && shot.selectedVideo?.path) return ok(shot)
    return ok(addShotVideo(shot.id, {
      path: job.output.path,
      providerTaskId: shot.providerTaskId!,
      provider: 'local-comfyui',
      model: shot.h3Model,
      preset: shot.h3Preset,
      width: shot.width,
      height: shot.height,
      seed: shot.seed,
      workflowVersion: WORKFLOW_VERSION,
      referenceImagePath: shot.referenceImagePath,
      duration: shot.duration,
      resolution: `${shot.width}x${shot.height}`,
    }))
  } catch (error) {
    const shot = getShot(shotId)
    if (shot?.status === 'generating') markShotFailed(shot.id, error instanceof Error ? error.message : '任务查询失败')
    return fail(error)
  }
}
