import { z } from 'zod'
import { addEntityImage, deleteEntityImage, getEntity, selectEntityImage } from '@/lib/db'
import { saveDataUrl } from '@/lib/local-media'
import { fail, ok } from '@/lib/api'

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('upload'), dataUrl: z.string().min(20) }),
  z.object({ action: z.literal('select'), imageId: z.string().uuid() }),
  z.object({ action: z.literal('delete'), imageId: z.string().uuid() }),
])

export async function POST(request: Request, { params }: { params: Promise<{ entityId: string }> }) {
  try {
    const { entityId } = await params
    const entity = getEntity(entityId)
    if (!entity) return fail('素材不存在', 404)
    const body = schema.parse(await request.json())
    if (body.action === 'delete') {
      const deleted = deleteEntityImage(entity.id, body.imageId)
      if (!deleted) return fail('图片版本不存在', 404)
      return ok(deleted.entity)
    }
    if (body.action === 'select') {
      const selected = selectEntityImage(entity.id, body.imageId)
      return selected ? ok(selected) : fail('图片版本不存在', 404)
    }
    if (body.action === 'upload') {
      const imagePath = await saveDataUrl(body.dataUrl, 'uploads')
      return ok(addEntityImage(entity.id, imagePath, '本地上传'))
    }
    return fail('不支持的图片操作', 400)
  } catch (error) {
    const status = error instanceof z.ZodError
      ? 400
      : error instanceof Error && error.message.includes('素材不存在或已删除')
        ? 404
        : 500
    return fail(error, status)
  }
}
