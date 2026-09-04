import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Entity, Episode, Project, ProjectBundle, Shot } from '@/lib/types'

const mocks = vi.hoisted(() => ({
  addShotVideo: vi.fn(),
  getProjectBundle: vi.fn(),
  getShot: vi.fn(),
  markShotFailed: vi.fn(),
  markShotGenerating: vi.fn(),
  markShotSubmitting: vi.fn(),
  fileToDataUrl: vi.fn(),
  saveRemoteFile: vi.fn(),
  createSeedanceTask: vi.fn(),
  querySeedanceTask: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  addShotVideo: mocks.addShotVideo,
  getProjectBundle: mocks.getProjectBundle,
  getShot: mocks.getShot,
  markShotFailed: mocks.markShotFailed,
  markShotGenerating: mocks.markShotGenerating,
  markShotSubmitting: mocks.markShotSubmitting,
}))
vi.mock('@/lib/local-media', () => ({
  fileToDataUrl: mocks.fileToDataUrl,
  saveRemoteFile: mocks.saveRemoteFile,
}))
vi.mock('@/lib/providers/seedance', () => ({
  createSeedanceTask: mocks.createSeedanceTask,
  querySeedanceTask: mocks.querySeedanceTask,
}))

import { POST } from './route'

const createdAt = '2026-08-11T00:00:00.000Z'
const project: Project = {
  id: 'project-1', title: '引用测试', brief: '', synopsis: '', genre: '穿越逆袭',
  visualStyle: '电影感写实', ratio: '9:16', plannedEpisodes: 2, createdAt, updatedAt: createdAt,
}
const episode: Episode = {
  id: 'episode-1', projectId: project.id, episodeNumber: 1, title: '第一集', content: '医馆密谈。',
  status: 'confirmed', createdAt, updatedAt: createdAt,
}

function entity(id: string, kind: Entity['kind'], name: string, variant: string, path: string): Entity {
  const image = { id: `${id}-image`, entityId: id, path, prompt: '', createdAt, url: `/api/media/${id}` }
  return {
    id, projectId: project.id, kind, name, variant, description: '', episodes: [1], category: '',
    metadata: kind === 'character' ? { role: name === '杨凌' ? 'protagonist' : 'supporting' } : {},
    voiceReferencePath: null, voiceReferenceTranscript: '', speechProvider: 'local-namaa', speechModel: '',
    selectedImageId: image.id, images: [image], selectedImage: image, createdAt, updatedAt: createdAt,
  }
}

const yang = entity('entity-yang', 'character', '杨凌', '默认形象', 'characters/yang.png')
const clinic = entity('entity-clinic', 'scene', '医馆_日', '', 'scenes/clinic.png')
const prompt = `素材引用与主体定义:
- 将 @杨凌-默认形象 定义为主角「杨凌」，保持面部、发型和服装一致
- 将 @医馆_日 定义为场景「医馆_日」，保持空间结构、陈设和光影氛围一致

分镜提示词:
场景：医馆_日
镜头1：中景缓推，杨凌站在木桌旁。`
const shot: Shot = {
  id: 'shot-1', projectId: project.id, episodeId: episode.id, shotOrder: 1, prompt, duration: 8,
  dialogue: '', referenceImagePath: null, width: 768, height: 1280, seed: 42,
  videoProvider: 'local-comfyui',
  h3Model: 'MiniMax-H3/minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  h3Preset: 'fl2va-turbo-4', turboMode: true,
  referenceEntityIds: [yang.id, clinic.id], status: 'pending', providerTaskId: null, error: null,
  selectedVideoId: null, videos: [], selectedVideo: null, createdAt, updatedAt: createdAt,
}
const bundle: ProjectBundle = { project, episodes: [episode], entities: [yang, clinic], shots: [shot], edits: [] }

function request(): Request {
  return new Request('http://localhost/api/shots/shot-1/video', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
}

afterEach(() => vi.resetAllMocks())

describe('POST /api/shots/[shotId]/video', () => {
  it('按 @标签编号顺序发送文字和 Base64 参考图片', async () => {
    mocks.getShot.mockReturnValue(shot)
    mocks.getProjectBundle.mockReturnValue(bundle)
    mocks.fileToDataUrl.mockImplementation(async (path: string) => `data:image/png;base64,${path}`)
    mocks.createSeedanceTask.mockResolvedValue('task-1')
    mocks.markShotGenerating.mockReturnValue({ ...shot, status: 'generating', providerTaskId: 'task-1' })

    const response = await POST(request(), { params: Promise.resolve({ shotId: shot.id }) })

    expect(response.status).toBe(202)
    expect(mocks.createSeedanceTask).toHaveBeenCalledWith(expect.objectContaining({
      model: 'doubao-seedance-2-0-260128',
      ratio: '9:16',
      resolution: '720p',
      duration: 8,
      content: [
        { type: 'text', text: expect.stringContaining('将 图片1 定义为主角「杨凌」') },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,characters/yang.png' }, role: 'reference_image' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,scenes/clinic.png' }, role: 'reference_image' },
      ],
    }))
    const submitted = mocks.createSeedanceTask.mock.calls[0]?.[0]
    expect(submitted.content[0].text).toContain('将 图片2 定义为场景「医馆_日」')
    expect(submitted.content[0].text).not.toContain('@杨凌-默认形象')
    expect(submitted.content[0].text).not.toContain('@医馆_日')
  })

  it('提示词引用未选素材时在付费调用前拒绝提交', async () => {
    mocks.getShot.mockReturnValue({ ...shot, referenceEntityIds: [yang.id] })
    mocks.getProjectBundle.mockReturnValue(bundle)

    const response = await POST(request(), { params: Promise.resolve({ shotId: shot.id }) })
    const payload = await response.json() as { error: string }

    expect(response.status).toBe(400)
    expect(payload.error).toContain('@医馆_日')
    expect(mocks.createSeedanceTask).not.toHaveBeenCalled()
  })
})
