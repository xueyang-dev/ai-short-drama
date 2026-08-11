import { z } from 'zod'
import { createShot, getProjectBundle, replaceStoryboard } from '@/lib/db'
import { generateStoryboard } from '@/lib/providers/deepseek'
import { resolveStoryboardReferenceEntities } from '@/lib/storyboard-references'
import { fail, ok } from '@/lib/api'

export const maxDuration = 600

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('generate'), episodeId: z.string().uuid() }),
  z.object({ action: z.literal('add'), episodeId: z.string().uuid() }),
])

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await params
    const body = schema.parse(await request.json())
    const bundle = getProjectBundle(projectId)
    if (!bundle) return fail('项目不存在', 404)
    const episode = bundle.episodes.find(item => item.id === body.episodeId)
    if (!episode) return fail('分集不存在', 404)
    if (episode.status !== 'confirmed') return fail('请先定稿本集剧本，再进入分镜制作', 409)
    if (body.action === 'add') return ok(createShot(projectId, episode.id), { status: 201 })
    if (!episode.content.trim()) return fail('本集剧本内容为空', 400)
    if (bundle.shots.some(shot => shot.episodeId === episode.id && shot.status === 'generating')) {
      return fail('本集仍有视频正在生成，完成后才能重新拆分分镜', 409)
    }
    const episodeEntities = bundle.entities.filter(entity => (
      entity.episodes.length === 0 || entity.episodes.includes(episode.episodeNumber)
    ))

    const generated = await generateStoryboard({
      episodeNumber: episode.episodeNumber,
      episodeTitle: episode.title,
      episodeContent: episode.content,
      visualStyle: bundle.project.visualStyle,
      ratio: bundle.project.ratio,
      entities: episodeEntities.map(entity => ({
        name: entity.name,
        variant: entity.variant,
        kind: entity.kind,
        description: entity.description,
        role: entity.kind === 'character' && typeof entity.metadata.role === 'string'
          ? entity.metadata.role.trim()
          : '',
        voiceDescription: entity.kind === 'character' && typeof entity.metadata.voiceDescription === 'string'
          ? entity.metadata.voiceDescription.trim()
          : '',
      })),
    })
    const shots = generated.shots.map((shot, index) => {
      const references = resolveStoryboardReferenceEntities(shot.prompt, episodeEntities)
      if (references.length > 9) throw new Error(`分镜 ${index + 1} 引用了 ${references.length} 张图片，Seedance 最多支持 9 张`)
      return {
        shotOrder: index + 1,
        prompt: shot.prompt,
        duration: shot.duration,
        referenceEntityIds: references.map(entity => entity.id),
      }
    })
    return ok(replaceStoryboard(projectId, episode.id, shots))
  } catch (error) {
    const status = error instanceof z.ZodError
      ? 400
      : error instanceof Error && error.message.includes('仍有视频正在生成')
        ? 409
        : 500
    return fail(error, status)
  }
}
