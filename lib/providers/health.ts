import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ProviderHealth } from './contracts'
import { localComfyUIProvider } from './comfyui'
import { providerEndpoint } from './local-url'

const execFileAsync = promisify(execFile)

async function httpHealth(
  id: string,
  name: string,
  envName: string,
  fallback: string,
  pathname: string,
): Promise<ProviderHealth> {
  const startedAt = Date.now()
  let endpoint = fallback
  try {
    const base = providerEndpoint(envName, fallback)
    endpoint = base.origin
    const response = await fetch(new URL(pathname, `${base.toString().replace(/\/$/, '')}/`), {
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>
    return {
      id, name, availability: 'available', endpoint, latencyMs: Date.now() - startedAt,
      message: '服务可用', capabilities: payload, checkedAt: new Date().toISOString(),
    }
  } catch (error) {
    return {
      id, name, availability: 'unavailable', endpoint, latencyMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString(),
    }
  }
}

async function executableHealth(id: string, name: string, executable: string, args: string[]): Promise<ProviderHealth> {
  const startedAt = Date.now()
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, { timeout: 5_000, windowsHide: true })
    const firstLine = `${stdout || stderr}`.split(/\r?\n/).find(Boolean) ?? '可用'
    return {
      id, name, availability: 'available', version: firstLine.trim(), latencyMs: Date.now() - startedAt,
      message: '可执行文件可用', checkedAt: new Date().toISOString(),
    }
  } catch (error) {
    return {
      id, name, availability: 'unavailable', latencyMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString(),
    }
  }
}

function derivedHealth(comfy: ProviderHealth, id: string, name: string, key: 'models' | 'systemStats'): ProviderHealth {
  const value = comfy.capabilities?.[key]
  const available = key === 'models' ? Array.isArray(value) && value.length > 0 : Boolean(value)
  return {
    id,
    name,
    availability: comfy.availability === 'unavailable' || !available ? 'unavailable' : 'available',
    endpoint: comfy.endpoint,
    message: available ? (key === 'models' ? `检测到 ${(value as unknown[]).length} 个 H3 checkpoint` : 'GPU 信息来自 ComfyUI') : '无法检测',
    capabilities: key === 'models' ? { models: value, presets: comfy.capabilities?.presets } : { systemStats: value },
    checkedAt: comfy.checkedAt,
  }
}

export async function getProviderHealth(): Promise<ProviderHealth[]> {
  const [comfy, localLlm, namaa, museTalk, ffmpeg] = await Promise.all([
    localComfyUIProvider.health(),
    httpHealth('local-llm', 'Local LLM', 'LOCAL_LLM_BASE_URL', 'http://127.0.0.1:1234/v1', 'models'),
    httpHealth('local-namaa', 'NAMAA Speech Worker', 'NAMAA_BASE_URL', 'http://127.0.0.1:8189', 'health'),
    httpHealth('local-musetalk', 'MuseTalk Worker', 'MUSETALK_BASE_URL', 'http://127.0.0.1:8190', 'health'),
    executableHealth('ffmpeg', 'FFmpeg', process.env.FFMPEG_PATH || 'ffmpeg', ['-version']),
  ])
  return [
    localLlm,
    comfy,
    derivedHealth(comfy, 'minimax-h3', 'MiniMax H3 Models', 'models'),
    namaa,
    museTalk,
    ffmpeg,
    derivedHealth(comfy, 'gpu', 'GPU', 'systemStats'),
  ]
}
