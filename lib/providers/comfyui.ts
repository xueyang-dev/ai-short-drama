import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { H3_PRESETS, h3ShotSettingsSchema, type H3PresetId } from '../h3-presets'
import { resolveMediaPath, saveRemoteFile } from '../local-media'
import type {
  ProviderHealth,
  ProviderJob,
  VideoGenerationOutput,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from './contracts'
import { providerEndpoint } from './local-url'

type WorkflowNode = { class_type: string; inputs: Record<string, unknown> }
type ApiWorkflow = Record<string, WorkflowNode>

const WORKFLOW_VERSION = 'minimax-h3/v1'
const TEMPLATE_PATH = path.join(process.cwd(), 'workflows', 'minimax-h3', 'v1', 'workflow-api.json')
const REQUIRED_NODES = [
  'MiniMaxH3EasyLoader',
  'MiniMaxH3Easy',
  'MiniMaxH3EasyMediaBridge',
  'MiniMaxH3EasyOutput',
  'ModelAttentionBackend',
  'SaveVideo',
] as const

interface ComfyOutputFile {
  filename: string
  subfolder?: string
  type?: string
}

interface ComfyHistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] }
  outputs?: Record<string, Record<string, ComfyOutputFile[] | unknown>>
}

function baseUrl(): URL {
  return providerEndpoint('COMFYUI_BASE_URL', 'http://127.0.0.1:8188')
}

function timeoutMs(): number {
  const configured = Number(process.env.COMFYUI_REQUEST_TIMEOUT_MS || 30_000)
  return Number.isFinite(configured) && configured >= 1_000 ? configured : 30_000
}

async function comfyFetch(pathname: string, init?: RequestInit): Promise<Response> {
  const url = new URL(pathname, baseUrl())
  const response = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs()), cache: 'no-store' })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`ComfyUI HTTP ${response.status}: ${body.slice(0, 800)}`)
  }
  return response
}

function replaceToken(value: unknown, token: string, replacement: string): unknown {
  if (value === token) return replacement
  if (Array.isArray(value)) return value.map(item => replaceToken(item, token, replacement))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceToken(item, token, replacement)]))
  }
  return value
}

export async function buildH3ApiWorkflow(
  request: VideoGenerationRequest,
  uploadedImages: string[],
): Promise<ApiWorkflow> {
  const settings = h3ShotSettingsSchema.parse({ ...request, referenceImagePaths: request.referenceImagePaths })
  if (uploadedImages.length !== settings.referenceImagePaths.length || uploadedImages.length === 0) {
    throw new Error('上传后的参考图片数量与请求不一致')
  }
  const preset = H3_PRESETS[settings.presetId]
  const source = await readFile(TEMPLATE_PATH, 'utf8')
  let workflow = JSON.parse(source) as ApiWorkflow
  const fl2vaModel = preset.modelFamily === 'fl2va' ? settings.model : '无'
  const ref2vaModel = preset.modelFamily === 'ref2va' ? settings.model : '无'
  workflow = replaceToken(workflow, '{{FL2VA_MODEL}}', fl2vaModel) as ApiWorkflow
  workflow = replaceToken(workflow, '{{REF2VA_MODEL}}', ref2vaModel) as ApiWorkflow
  workflow = replaceToken(workflow, '{{MODE}}', preset.modelFamily === 'ref2va' ? 'reference' : 'image') as ApiWorkflow
  workflow = replaceToken(workflow, '{{PROMPT}}', settings.prompt) as ApiWorkflow
  workflow = replaceToken(workflow, '{{REFERENCE_IMAGE}}', uploadedImages[0]) as ApiWorkflow

  workflow['2'].inputs = {
    ...workflow['2'].inputs,
    width: settings.width,
    height: settings.height,
    seconds: settings.duration,
    aspect_ratio: settings.width >= settings.height ? '16:9' : '9:16',
  }
  workflow['5'].inputs.steps = preset.steps
  workflow['6'].inputs.noise_seed = settings.seed
  workflow['12'].inputs.filename_prefix = `ai-short-drama/h3-${randomUUID()}`

  const bridgeInputs: Record<string, unknown> = {
    image_count: uploadedImages.length,
    video_count: 0,
    audio_count: 0,
  }
  uploadedImages.forEach((image, index) => {
    const nodeId = String(100 + index)
    workflow[nodeId] = { class_type: 'LoadImage', inputs: { image } }
    bridgeInputs[`image_${index + 1}`] = [nodeId, 0]
  })
  workflow['14'].inputs = bridgeInputs

  if (preset.loraFilename) {
    workflow = replaceToken(workflow, '{{LORA}}', preset.loraFilename) as ApiWorkflow
  } else {
    delete workflow['24']
    workflow['34'].inputs.model = ['2', 0]
  }
  return workflow
}

async function uploadReference(relativePath: string): Promise<string> {
  const absolutePath = resolveMediaPath(relativePath)
  const buffer = await readFile(absolutePath)
  const originalName = path.basename(absolutePath)
  const name = `${randomUUID()}${path.extname(originalName) || '.png'}`
  const form = new FormData()
  form.append('image', new Blob([buffer]), name)
  form.append('type', 'input')
  form.append('subfolder', 'ai-short-drama')
  form.append('overwrite', 'false')
  const response = await comfyFetch('/upload/image', { method: 'POST', body: form })
  const uploaded = await response.json() as { name?: string; subfolder?: string }
  if (!uploaded.name) throw new Error('ComfyUI 未返回上传图片名称')
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name
}

function findVideo(entry: ComfyHistoryEntry): ComfyOutputFile | null {
  for (const output of Object.values(entry.outputs ?? {})) {
    for (const key of ['videos', 'gifs', 'files']) {
      const files = output[key]
      if (Array.isArray(files) && files.length > 0) return files[0] as ComfyOutputFile
    }
  }
  return null
}

function historyError(entry: ComfyHistoryEntry): string {
  return JSON.stringify(entry.status?.messages ?? []).slice(0, 1000) || 'ComfyUI 任务失败'
}

export class LocalComfyUIProvider implements VideoGenerationProvider {
  readonly id = 'local-comfyui'

  async health(): Promise<ProviderHealth> {
    const startedAt = Date.now()
    const endpoint = baseUrl().origin
    try {
      const [statsResponse, loaderResponse, ...nodeResponses] = await Promise.all([
        comfyFetch('/system_stats'),
        comfyFetch('/object_info/MiniMaxH3EasyLoader'),
        ...REQUIRED_NODES.map(node => comfyFetch(`/object_info/${node}`)),
      ])
      const stats = await statsResponse.json() as Record<string, unknown>
      const loaderInfo = await loaderResponse.json() as Record<string, {
        input?: { required?: { fl2va_model?: [string[]]; ref2va_model?: [string[]] } }
      }>
      const availableNodes = REQUIRED_NODES.filter((_, index) => nodeResponses[index].ok)
      const loader = loaderInfo.MiniMaxH3EasyLoader
      const modelNames = Array.from(new Set([
        ...(loader?.input?.required?.fl2va_model?.[0] ?? []),
        ...(loader?.input?.required?.ref2va_model?.[0] ?? []),
      ].filter(name => name.toLowerCase().includes('minimax-h3') || name.toLowerCase().includes('pinkcherry'))))
      const missingNodes = REQUIRED_NODES.filter(node => !availableNodes.includes(node))
      return {
        id: this.id,
        name: 'Local ComfyUI',
        availability: missingNodes.length ? 'degraded' : 'available',
        endpoint,
        latencyMs: Date.now() - startedAt,
        message: missingNodes.length ? `缺少节点：${missingNodes.join(', ')}` : 'ComfyUI 与 MiniMax H3 节点可用',
        capabilities: { workflowVersion: WORKFLOW_VERSION, models: modelNames, presets: Object.keys(H3_PRESETS), systemStats: stats },
        checkedAt: new Date().toISOString(),
      }
    } catch (error) {
      return {
        id: this.id,
        name: 'Local ComfyUI',
        availability: 'unavailable',
        endpoint,
        latencyMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      }
    }
  }

  async submit(request: VideoGenerationRequest): Promise<ProviderJob<VideoGenerationOutput>> {
    const uploadedImages: string[] = []
    for (const imagePath of request.referenceImagePaths) uploadedImages.push(await uploadReference(imagePath))
    const prompt = await buildH3ApiWorkflow(request, uploadedImages)
    const response = await comfyFetch('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: `ai-short-drama-${randomUUID()}` }),
    })
    const result = await response.json() as { prompt_id?: string; error?: unknown; node_errors?: unknown }
    if (!result.prompt_id) throw new Error(`ComfyUI 拒绝 workflow：${JSON.stringify(result.error ?? result.node_errors ?? result)}`)
    return { id: result.prompt_id, state: 'queued' }
  }

  async getJob(jobId: string): Promise<ProviderJob<VideoGenerationOutput>> {
    const response = await comfyFetch(`/history/${encodeURIComponent(jobId)}`)
    const history = await response.json() as Record<string, ComfyHistoryEntry>
    const entry = history[jobId]
    if (!entry) return { id: jobId, state: 'running' }
    const video = findVideo(entry)
    if (video) {
      const viewUrl = new URL('/view', baseUrl())
      viewUrl.searchParams.set('filename', video.filename)
      viewUrl.searchParams.set('subfolder', video.subfolder ?? '')
      viewUrl.searchParams.set('type', video.type ?? 'output')
      const mediaPath = await saveRemoteFile(viewUrl.toString(), 'videos', 'mp4')
      return { id: jobId, state: 'succeeded', progress: 1, output: { path: mediaPath, mimeType: 'video/mp4' } }
    }
    if (entry.status?.status_str === 'error') return { id: jobId, state: 'failed', error: historyError(entry) }
    return { id: jobId, state: entry.status?.completed ? 'failed' : 'running', error: entry.status?.completed ? 'ComfyUI 已完成但没有视频输出' : undefined }
  }
}

export const localComfyUIProvider = new LocalComfyUIProvider()
export { WORKFLOW_VERSION }
