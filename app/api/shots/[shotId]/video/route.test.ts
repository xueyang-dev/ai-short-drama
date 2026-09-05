import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Entity, Episode, Project, ProjectBundle, Shot } from '@/lib/types'

const mocks = vi.hoisted(() => ({
  getShot: vi.fn(),
  getProjectBundle: vi.fn(),
  updateShot: vi.fn(),
  markShotSubmitting: vi.fn(),
  markShotGenerating: vi.fn(),
  markShotFailed: vi.fn(),
  addShotVideo: vi.fn(),
  submit: vi.fn(),
  getJob: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  getShot: mocks.getShot,
  getProjectBundle: mocks.getProjectBundle,
  updateShot: mocks.updateShot,
  markShotSubmitting: mocks.markShotSubmitting,
  markShotGenerating: mocks.markShotGenerating,
  markShotFailed: mocks.markShotFailed,
  addShotVideo: mocks.addShotVideo,
}))

vi.mock('@/lib/providers/comfyui', () => ({
  WORKFLOW_VERSION: 'minimax-h3/v1',
  localComfyUIProvider: { submit: mocks.submit, getJob: mocks.getJob },
}))

import { GET, POST } from './route'

const createdAt = '2026-09-05T00:00:00.000Z'
const project: Project = {
  id: 'project-1', title: 'Arabic Drama', brief: '', synopsis: '', genre: 'drama',
  visualStyle: 'cinematic', ratio: '9:16', plannedEpisodes: 1, createdAt, updatedAt: createdAt,
}
const episode: Episode = {
  id: 'episode-1', projectId: project.id, episodeNumber: 1, title: 'الحلقة الأولى', content: 'مشهد',
  status: 'confirmed', createdAt, updatedAt: createdAt,
}
const image = {
  id: 'image-1', entityId: 'entity-1', path: 'uploads/reference.png', prompt: '本地上传', createdAt,
  url: '/api/media/uploads/reference.png',
}
const entity: Entity = {
  id: 'entity-1', projectId: project.id, kind: 'character', name: 'ليان', variant: 'default',
  description: '', episodes: [1], category: '', metadata: {}, voiceReferencePath: null,
  voiceReferenceTranscript: '', speechProvider: 'local-namaa', speechModel: '', selectedImageId: image.id,
  images: [image], selectedImage: image, createdAt, updatedAt: createdAt,
}
const baseShot: Shot = {
  id: 'shot-1', projectId: project.id, episodeId: episode.id, shotOrder: 1,
  prompt: 'لقطة قريبة لليان', dialogue: '', duration: 5, referenceImagePath: null,
  referenceEntityIds: [entity.id], width: 768, height: 1280, seed: 42,
  videoProvider: 'local-comfyui', h3Model: 'MiniMax-H3/minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  h3Preset: 'fl2va-turbo-4', turboMode: true, status: 'pending', providerTaskId: null, error: null,
  selectedVideoId: null, videos: [], selectedVideo: null, createdAt, updatedAt: createdAt,
}
const bundle: ProjectBundle = { project, episodes: [episode], entities: [entity], shots: [baseShot], edits: [] }

function postRequest(body: Record<string, unknown> = {}): Request {
  return new Request('http://localhost/api/shots/shot-1/video', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.getShot.mockReturnValue(baseShot)
  mocks.getProjectBundle.mockReturnValue(bundle)
  mocks.updateShot.mockImplementation((_id, fields) => ({ ...baseShot, ...fields }))
  mocks.submit.mockResolvedValue({ id: 'comfy-prompt-1', state: 'queued' })
  mocks.markShotGenerating.mockReturnValue({ ...baseShot, status: 'generating', providerTaskId: 'comfy-prompt-1' })
})

describe('Local ComfyUI shot video route', () => {
  it('submits exact persisted H3 settings and reference media', async () => {
    const response = await POST(postRequest({ seed: 99 }), { params: Promise.resolve({ shotId: baseShot.id }) })
    expect(response.status).toBe(202)
    expect(mocks.submit).toHaveBeenCalledWith(expect.objectContaining({
      referenceImagePaths: ['uploads/reference.png'], width: 768, height: 1280, duration: 5,
      seed: 99, model: baseShot.h3Model, presetId: 'fl2va-turbo-4', turboMode: true,
    }))
    expect(mocks.markShotGenerating).toHaveBeenCalledWith(
      baseShot.id, 'comfy-prompt-1', baseShot.h3Model, '768x1280', 'minimax-h3/v1',
    )
  })

  it('does not submit without a reference image', async () => {
    mocks.getProjectBundle.mockReturnValue({ ...bundle, entities: [{ ...entity, selectedImage: null }] })
    const response = await POST(postRequest(), { params: Promise.resolve({ shotId: baseShot.id }) })
    expect(response.status).toBe(400)
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('writes a completed ComfyUI result back as a selectable TAKE', async () => {
    const generating = { ...baseShot, status: 'generating' as const, providerTaskId: 'comfy-prompt-1' }
    mocks.getShot.mockReturnValue(generating)
    mocks.getJob.mockResolvedValue({
      id: 'comfy-prompt-1', state: 'succeeded', output: { path: 'videos/take.mp4', mimeType: 'video/mp4' },
    })
    mocks.addShotVideo.mockReturnValue({ ...generating, status: 'success' })
    const response = await GET(new Request('http://localhost'), { params: Promise.resolve({ shotId: baseShot.id }) })
    expect(response.status).toBe(200)
    expect(mocks.addShotVideo).toHaveBeenCalledWith(baseShot.id, expect.objectContaining({
      path: 'videos/take.mp4', provider: 'local-comfyui', workflowVersion: 'minimax-h3/v1', seed: 42,
    }))
  })
})
