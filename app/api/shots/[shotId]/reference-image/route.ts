import { z } from 'zod'
import { getShot, updateShot } from '@/lib/db'
import { saveDataUrl } from '@/lib/local-media'
import { fail, ok } from '@/lib/api'

const schema = z.object({ dataUrl: z.string().min(20) })

export async function POST(request: Request, { params }: { params: Promise<{ shotId: string }> }) {
  try {
    const { shotId } = await params
    const shot = getShot(shotId)
    if (!shot) return fail('分镜不存在', 404)
    if (shot.status === 'generating') return fail('镜头生成期间不能替换参考图', 409)
    const { dataUrl } = schema.parse(await request.json())
    const imagePath = await saveDataUrl(dataUrl, 'uploads')
    return ok(updateShot(shot.id, { referenceImagePath: imagePath }))
  } catch (error) {
    return fail(error, error instanceof z.ZodError ? 400 : 500)
  }
}
