import { z } from 'zod'
import { resolveVideoStylePrompt } from '@/config/video-styles'
import { DiagnosticError, type PublicDiagnostics } from '../diagnostic-error'
import {
  LOCAL_LLM_DEFAULT_MAX_OUTPUT_TOKENS,
  LOCAL_LLM_DEFAULT_MODEL,
  MAX_SCRIPT_EPISODES_PER_REQUEST,
} from '../model-config'
import type { EntityKind, GeneratedScript, GeneratedStoryboard } from '../types'
import { getStoryboardReferenceTag } from '../storyboard-references'
import { loadSkillPrompt } from '../skills'
import { providerEndpoint } from './local-url'

const generatedScriptSchema = z.object({
  summary: z.object({
    title: z.string().min(1),
    synopsis: z.string().min(1),
    genre: z.string().min(1),
    protagonist: z.string().default(''),
    background: z.string().default(''),
    setting: z.string().default(''),
    oneSentence: z.string().default(''),
  }),
  episodes: z.array(z.object({
    episodeNumber: z.number().int().positive(),
    title: z.string(),
    content: z.string().min(1),
  })).min(1),
  characters: z.array(z.object({
    name: z.string().min(1),
    role: z.string().default('supporting'),
    gender: z.string().default('unknown'),
    introduction: z.string().default(''),
    voiceDescription: z.string().default(''),
    looks: z.array(z.object({
      name: z.string().min(1).default('默认形象'),
      description: z.string().min(1),
      episodes: z.array(z.number().int().positive()).default([]),
      voiceDescription: z.string().optional(),
    })).min(1),
  })),
  scenes: z.array(z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    episodes: z.array(z.number().int().positive()).default([]),
  })),
  props: z.array(z.object({
    name: z.string().min(1),
    category: z.string().default('item'),
    description: z.string().min(1),
    episodes: z.array(z.number().int().positive()).default([]),
  })),
})

const generatedStoryboardSchema = z.object({
  shots: z.array(z.object({
    shotOrder: z.number().int().positive(),
    sceneName: z.string().default(''),
    characters: z.array(z.string()).default([]),
    action: z.string().default(''),
    dialogue: z.string().default(''),
    prompt: z.string().min(1),
    duration: z.number().int().min(4).max(15),
  })).min(1),
})

const optimizedScriptBriefSchema = z.object({
  brief: z.string().min(1).max(100_000),
  genreDetected: z.string().default(''),
  tips: z.array(z.string()).max(5).default([]),
})

const skillQualityAreaSchema = z.object({
  score: z.number().int().min(0).max(100),
  strengths: z.array(z.string().min(1)).max(8),
  weaknesses: z.array(z.string().min(1)).max(8),
  evidence: z.array(z.string().min(1)).max(8),
})

const shortDramaSkillQualitySchema = z.object({
  skills: z.object({
    scriptBrief: skillQualityAreaSchema,
    dramaScript: skillQualityAreaSchema,
    dramaShotPrompt: skillQualityAreaSchema,
  }),
  workflow: z.object({
    score: z.number().int().min(0).max(100),
    verdict: z.enum(['excellent', 'pass', 'needs_improvement', 'fail']),
    blockingIssues: z.array(z.string().min(1)).max(8),
    recommendations: z.array(z.string().min(1)).max(8),
  }),
})

export type ShortDramaSkillQualityJudgement = z.output<typeof shortDramaSkillQualitySchema>

// DeepSeek 官方说明 JSON Output 偶尔会返回空 content；只对可恢复的响应问题限次重试。
const DEEPSEEK_JSON_MAX_ATTEMPTS = 2
const DEEPSEEK_JSON_RETRY_INSTRUCTION = `【JSON 输出重试要求】
上一次调用没有产生可用的正式答案。本次必须完成正式回答，并且只在 content 中输出一个完整 JSON 对象；不要只输出思考过程，不要解释，不要使用 Markdown 代码块。`

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1))
    throw new Error('DeepSeek 未返回有效 JSON')
  }
}

function normalizeGeneratedScriptPayload(value: unknown): unknown {
  const root = asRecord(value)
  const summary = asRecord(root?.summary)
  if (!root || !summary) return value

  const normalizedRoot = { ...root }
  const normalizedSummary = { ...summary }
  for (const key of ['episodes', 'characters', 'scenes', 'props'] as const) {
    if (normalizedRoot[key] === undefined && normalizedSummary[key] !== undefined) {
      normalizedRoot[key] = normalizedSummary[key]
      delete normalizedSummary[key]
    }
  }
  normalizedRoot.summary = normalizedSummary
  return normalizedRoot
}

function describeZodIssues(error: z.ZodError): string {
  return error.issues.slice(0, 3).map(issue => {
    const path = issue.path.length ? issue.path.join('.') : 'root'
    return `${path}: ${issue.message}`
  }).join('；')
}

async function callDeepSeekJson<Schema extends z.ZodTypeAny>(
  systemPrompt: string,
  userPrompt: string,
  schema: Schema,
  normalize?: (value: unknown) => unknown,
): Promise<z.output<Schema>> {
  const apiKey = process.env.LOCAL_LLM_API_KEY
  const baseUrl = providerEndpoint('LOCAL_LLM_BASE_URL', 'http://127.0.0.1:1234/v1').toString().replace(/\/$/, '')
  const model = process.env.LOCAL_LLM_MODEL || LOCAL_LLM_DEFAULT_MODEL
  const configuredMaxTokens = Number(process.env.LOCAL_LLM_MAX_OUTPUT_TOKENS || LOCAL_LLM_DEFAULT_MAX_OUTPUT_TOKENS)
  const maxTokens = Number.isInteger(configuredMaxTokens) && configuredMaxTokens > 0
    ? configuredMaxTokens
    : LOCAL_LLM_DEFAULT_MAX_OUTPUT_TOKENS
  const diagnosticBase: DeepSeekDiagnosticBase = {
    diagnosticId: crypto.randomUUID(),
    model,
    startedAt: Date.now(),
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000)

  try {
    for (let attempt = 1; attempt <= DEEPSEEK_JSON_MAX_ATTEMPTS; attempt += 1) {
      const attemptPrompt = attempt === 1
        ? userPrompt
        : `${userPrompt}\n\n${DEEPSEEK_JSON_RETRY_INSTRUCTION}`
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: attemptPrompt },
          ],
          response_format: { type: 'json_object' },
          max_tokens: maxTokens,
          stream: true,
        }),
        signal: controller.signal,
      })
      const responseMetadata: DeepSeekResponseMetadata = {
        attempt,
        maxAttempts: DEEPSEEK_JSON_MAX_ATTEMPTS,
        httpStatus: response.status,
        contentType: response.headers.get('content-type'),
        providerRequestId: getProviderRequestId(response),
      }
      if (!response.ok) {
        const raw = await response.text()
        let providerMessage = ''
        let errorCode: string | undefined
        try {
          const parsed = asRecord(JSON.parse(raw))
          const providerError = asRecord(parsed?.error)
          providerMessage = readString(providerError?.message)
          errorCode = readString(providerError?.code) || undefined
        } catch {
          // 非 JSON 错误响应仍由下方安全摘要记录。
        }
        throw createDeepSeekError(
          `DeepSeek API 错误 (${response.status})${providerMessage ? `：${providerMessage}` : ''}`,
          diagnosticBase,
          'http',
          { ...responseMetadata, rawResponseLength: raw.length, errorCode },
          raw,
        )
      }

      let collected: DeepSeekCollectedResponse
      try {
        collected = response.headers.get('content-type')?.includes('text/event-stream')
          ? await collectStreamResponse(response)
          : collectJsonResponse(await response.text())
      } catch (error) {
        if (attempt < DEEPSEEK_JSON_MAX_ATTEMPTS) {
          logDeepSeekRetry(diagnosticBase, 'response_parse', responseMetadata)
          continue
        }
        throw createDeepSeekError(
          'DeepSeek 响应无法解析',
          diagnosticBase,
          'response_parse',
          responseMetadata,
          undefined,
          error,
        )
      }

      const metadata = { ...responseMetadata, ...collected }
      if ((collected.malformedStreamEventCount ?? 0) > 0) {
        console.warn('[雪风AI短剧工坊][DeepSeek] 已忽略异常 SSE 事件', compactDiagnostics({
          diagnosticId: diagnosticBase.diagnosticId,
          provider: 'deepseek',
          model,
          attempt,
          malformedStreamEventCount: collected.malformedStreamEventCount,
          providerRequestId: metadata.providerRequestId,
          providerResponseId: metadata.providerResponseId,
        }))
      }
      if (collected.providerError) {
        throw createDeepSeekError(
          collected.providerError.message || 'DeepSeek 调用失败',
          diagnosticBase,
          'provider_error',
          { ...metadata, errorCode: collected.providerError.code },
        )
      }
      if (!collected.content.trim()) {
        if (attempt < DEEPSEEK_JSON_MAX_ATTEMPTS) {
          logDeepSeekRetry(diagnosticBase, 'empty_content', metadata)
          continue
        }
        throw createDeepSeekError(
          'DeepSeek 连续两次返回内容为空',
          diagnosticBase,
          'empty_content',
          metadata,
        )
      }

      let extracted: unknown
      try {
        extracted = extractJson(collected.content)
      } catch (error) {
        throw createDeepSeekError(
          'DeepSeek 未返回有效 JSON',
          diagnosticBase,
          'json_parse',
          metadata,
          collected.content,
          error,
        )
      }
      try {
        return schema.parse(normalize ? normalize(extracted) : extracted)
      } catch (error) {
        if (!(error instanceof z.ZodError)) throw error
        throw createDeepSeekError(
          `DeepSeek 返回结构不符合要求：${describeZodIssues(error) || '结构错误'}`,
          diagnosticBase,
          'schema_validation',
          metadata,
          collected.content,
          error,
        )
      }
    }
    throw new Error('DeepSeek JSON 重试状态异常')
  } catch (error) {
    if (error instanceof DiagnosticError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw createDeepSeekError('DeepSeek 请求超时', diagnosticBase, 'timeout', {}, undefined, error)
    }
    throw createDeepSeekError(
      `DeepSeek 请求失败：${error instanceof Error ? error.message : '未知错误'}`,
      diagnosticBase,
      'network',
      {},
      undefined,
      error,
    )
  } finally {
    clearTimeout(timer)
  }
}

export async function optimizeScriptBrief(input: {
  brief: string
  title?: string
  genre: string
  visualStyle: string
  ratio: string
}) {
  const systemPrompt = await loadSkillPrompt('script-brief')
  const visualStyle = resolveVideoStylePrompt(input.visualStyle)
  const userPrompt = `请使用本 Skill 优化下面的爽剧创作需求，保留用户已经明确的人物、关系、情节、结局和禁忌。只返回符合 Skill 输出契约的 JSON。

剧名：${input.title?.trim() || '暂未命名'}
题材：${input.genre}
画面比例：${input.ratio}
视觉风格：${visualStyle}

用户原始想法或素材：
${input.brief}`

  return callDeepSeekJson(systemPrompt, userPrompt, optimizedScriptBriefSchema)
}

export interface ScriptGenerationInput {
  title: string
  brief: string
  synopsis?: string
  genre: string
  visualStyle: string
  ratio: string
  episodeCount: number
  plannedEpisodes: number | null
  mode?: 'generate' | 'continue' | 'rewrite'
  startEpisode?: number
  existingEpisodes?: Array<{ episodeNumber: number; title: string; content: string }>
  instruction?: string
  isFinale?: boolean
}

type DeepSeekFailurePhase =
  | 'network'
  | 'timeout'
  | 'http'
  | 'response_parse'
  | 'provider_error'
  | 'empty_content'
  | 'json_parse'
  | 'schema_validation'

interface DeepSeekDiagnosticBase {
  diagnosticId: string
  model: string
  startedAt: number
}

interface DeepSeekResponseMetadata {
  attempt?: number
  maxAttempts?: number
  httpStatus?: number
  contentType?: string | null
  providerRequestId?: string
  providerResponseId?: string
  rawResponseLength?: number
  streamChunkCount?: number
  choicesCount?: number
  finishReason?: string | null
  contentLength?: number
  reasoningContentLength?: number
  malformedStreamEventCount?: number
  errorCode?: string
}

interface DeepSeekCollectedResponse extends DeepSeekResponseMetadata {
  content: string
  reasoningContent: string
  providerError?: { message?: string; code?: string }
}

function compactDiagnostics(values: Record<string, string | number | boolean | null | undefined>): PublicDiagnostics {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined),
  )
}

function sanitizeResponsePreview(value: string): string {
  return value
    .slice(0, 1_000)
    .replace(/data:[^;,\s]+;base64,[a-z0-9+/=\r\n]+/gi, 'data:[base64 omitted]')
    .replace(/\bsk-[a-z0-9_-]{12,}\b/gi, '[api-key omitted]')
}

function logDeepSeekRetry(
  base: DeepSeekDiagnosticBase,
  phase: 'response_parse' | 'empty_content',
  metadata: DeepSeekResponseMetadata,
): void {
  console.warn('[雪风AI短剧工坊][DeepSeek] 响应异常，自动重试', compactDiagnostics({
    diagnosticId: base.diagnosticId,
    provider: 'deepseek',
    model: base.model,
    phase,
    durationMs: Date.now() - base.startedAt,
    attempt: metadata.attempt,
    maxAttempts: metadata.maxAttempts,
    httpStatus: metadata.httpStatus,
    contentType: metadata.contentType,
    providerRequestId: metadata.providerRequestId,
    providerResponseId: metadata.providerResponseId,
    rawResponseLength: metadata.rawResponseLength,
    streamChunkCount: metadata.streamChunkCount,
    choicesCount: metadata.choicesCount,
    finishReason: metadata.finishReason,
    contentLength: metadata.contentLength,
    reasoningContentLength: metadata.reasoningContentLength,
    malformedStreamEventCount: metadata.malformedStreamEventCount,
  }))
}

function createDeepSeekError(
  message: string,
  base: DeepSeekDiagnosticBase,
  phase: DeepSeekFailurePhase,
  metadata: DeepSeekResponseMetadata = {},
  responsePreview?: string,
  cause?: unknown,
): DiagnosticError {
  const diagnostics = compactDiagnostics({
    diagnosticId: base.diagnosticId,
    provider: 'deepseek',
    model: base.model,
    phase,
    durationMs: Date.now() - base.startedAt,
    attempt: metadata.attempt,
    maxAttempts: metadata.maxAttempts,
    httpStatus: metadata.httpStatus,
    contentType: metadata.contentType,
    providerRequestId: metadata.providerRequestId,
    providerResponseId: metadata.providerResponseId,
    rawResponseLength: metadata.rawResponseLength,
    streamChunkCount: metadata.streamChunkCount,
    choicesCount: metadata.choicesCount,
    finishReason: metadata.finishReason,
    contentLength: metadata.contentLength,
    reasoningContentLength: metadata.reasoningContentLength,
    malformedStreamEventCount: metadata.malformedStreamEventCount,
    errorCode: metadata.errorCode,
  })
  console.error('[雪风AI短剧工坊][DeepSeek] 调用失败', {
    message,
    ...diagnostics,
    ...(responsePreview ? { responsePreview: sanitizeResponsePreview(responsePreview) } : {}),
  })
  return new DiagnosticError(message, diagnostics, cause === undefined ? undefined : { cause })
}

function getProviderRequestId(response: Response): string | undefined {
  return response.headers.get('x-request-id')
    || response.headers.get('request-id')
    || response.headers.get('x-ds-trace-id')
    || undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function collectJsonResponse(raw: string): DeepSeekCollectedResponse {
  const payload = asRecord(JSON.parse(raw)) ?? {}
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  const firstChoice = asRecord(choices[0])
  const message = asRecord(firstChoice?.message)
  const error = asRecord(payload.error)
  const content = readString(message?.content)
  const reasoningContent = readString(message?.reasoning_content)

  return {
    content,
    reasoningContent,
    providerError: error ? {
      message: readString(error.message) || undefined,
      code: readString(error.code) || undefined,
    } : undefined,
    providerResponseId: readString(payload.id) || undefined,
    rawResponseLength: raw.length,
    choicesCount: choices.length,
    finishReason: typeof firstChoice?.finish_reason === 'string' ? firstChoice.finish_reason : null,
    contentLength: content.length,
    reasoningContentLength: reasoningContent.length,
  }
}

async function collectStreamResponse(response: Response): Promise<DeepSeekCollectedResponse> {
  if (!response.body) throw new Error('DeepSeek 流式响应没有 body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let reasoningContent = ''
  let providerResponseId: string | undefined
  let finishReason: string | null = null
  let rawResponseLength = 0
  let streamChunkCount = 0
  let choicesCount = 0
  let malformedStreamEventCount = 0
  let providerError: DeepSeekCollectedResponse['providerError']

  const consumeLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') return

    try {
      const payload = asRecord(JSON.parse(data)) ?? {}
      providerResponseId ||= readString(payload.id) || undefined
      const error = asRecord(payload.error)
      if (error) {
        providerError = {
          message: readString(error.message) || undefined,
          code: readString(error.code) || undefined,
        }
      }

      const choices = Array.isArray(payload.choices) ? payload.choices : []
      choicesCount = Math.max(choicesCount, choices.length)
      const firstChoice = asRecord(choices[0])
      const delta = asRecord(firstChoice?.delta)
      content += readString(delta?.content)
      reasoningContent += readString(delta?.reasoning_content)
      if (typeof firstChoice?.finish_reason === 'string') finishReason = firstChoice.finish_reason
    } catch {
      malformedStreamEventCount += 1
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      rawResponseLength += value.byteLength
      streamChunkCount += 1
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      lines.forEach(consumeLine)
    }
    buffer += decoder.decode()
    if (buffer.trim()) consumeLine(buffer)
  } finally {
    reader.releaseLock()
  }

  return {
    content,
    reasoningContent,
    providerError,
    providerResponseId,
    rawResponseLength,
    streamChunkCount,
    choicesCount,
    finishReason,
    contentLength: content.length,
    reasoningContentLength: reasoningContent.length,
    malformedStreamEventCount,
  }
}

interface SceneCountRange {
  min: number
  max: number
  source: 'default' | 'user'
}

const MIN_SCRIPT_SCENES = 8
const RECOMMENDED_SCRIPT_SCENES = 10
const MAX_SCRIPT_SCENES = 15

function requireSupportedSceneCount(min: number, max: number): void {
  if (min < MIN_SCRIPT_SCENES || max > MAX_SCRIPT_SCENES) {
    throw new Error(`单集场数必须在 ${MIN_SCRIPT_SCENES}–${MAX_SCRIPT_SCENES} 场之间`)
  }
}

interface SceneHeading {
  number: number
  signature: string
}

function resolveSceneCountRange(input: ScriptGenerationInput): SceneCountRange {
  const requirements = `${input.brief}\n${input.instruction ?? ''}`
  const rangeMatch = requirements.match(/(?:每集|单集|每一集)[^\n。；]{0,20}?(\d{1,2})\s*[-–—~至到]\s*(\d{1,2})\s*场/)
  if (rangeMatch) {
    const left = Number(rangeMatch[1])
    const right = Number(rangeMatch[2])
    const min = Math.min(left, right)
    const max = Math.max(left, right)
    requireSupportedSceneCount(min, max)
    return { min, max, source: 'user' }
  }
  const exactMatch = requirements.match(/(?:必须|务必|严格)?\s*(?:恰好|正好|固定为|限定为|控制为)\s*(\d{1,2})\s*场/)
    ?? requirements.match(/(?:每集|单集|每一集)[^\n。；]{0,20}?(\d{1,2})\s*场/)
  if (exactMatch) {
    const count = Number(exactMatch[1])
    requireSupportedSceneCount(count, count)
    return { min: count, max: count, source: 'user' }
  }
  return { min: MIN_SCRIPT_SCENES, max: MAX_SCRIPT_SCENES, source: 'default' }
}

function parseSceneHeadings(content: string): SceneHeading[] {
  return content.split(/\r?\n/).flatMap(line => {
    const match = line.trim().match(/^\[(\d+)\]\s+(内|外)\s+(.+?)\s+(晨|日|昏|夜)$/)
    if (!match) return []
    return [{
      number: Number(match[1]),
      signature: `${match[2]}\u0000${match[3].trim()}\u0000${match[4]}`,
    }]
  })
}

function normalizeEpisodeSceneSpacing(content: string): string {
  const lines = content.replace(/\r\n?/g, '\n').trim().split('\n')
  const normalized: string[] = []

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    const isSceneHeading = /^\s*\[\d+\]\s+(?:内|外)\s+.+\s+(?:晨|日|昏|夜)\s*$/.test(line)
    if (isSceneHeading && normalized.length > 0) {
      while (normalized.at(-1) === '') normalized.pop()
      normalized.push('')
    }
    normalized.push(isSceneHeading ? line.trim() : line)
  }

  return normalized.join('\n')
}

function validateEpisodeScenes(
  episodes: Array<{ content: string }>,
  startEpisode: number,
  sceneCountRange: SceneCountRange,
): string[] {
  const issues: string[] = []
  episodes.forEach((episode, index) => {
    const episodeNumber = startEpisode + index
    const headings = parseSceneHeadings(episode.content)
    if (headings.length < sceneCountRange.min || headings.length > sceneCountRange.max) {
      issues.push(`第 ${episodeNumber} 集只有 ${headings.length} 场，要求 ${sceneCountRange.min === sceneCountRange.max ? `${sceneCountRange.min} 场` : `${sceneCountRange.min}–${sceneCountRange.max} 场`}`)
    }
    if (!headings.every((heading, headingIndex) => heading.number === headingIndex + 1)) {
      issues.push(`第 ${episodeNumber} 集场号必须从 [1] 开始连续递增，且不得中途重置`)
    }
    const repeatedScene = headings.find((heading, headingIndex) => (
      headingIndex > 0 && heading.signature === headings[headingIndex - 1]?.signature
    ))
    if (repeatedScene) issues.push(`第 ${episodeNumber} 集存在连续相同地点与时间的拆场，必须合并`)
  })
  return issues
}

function normalizeGeneratedEpisodeReferences(
  episodes: number[],
  startEpisode: number,
  episodeCount: number,
  relativeNumbering: boolean,
): number[] {
  const endEpisode = startEpisode + episodeCount - 1
  return [...new Set(episodes.map(episode => {
    if (relativeNumbering && episode >= 1 && episode <= episodeCount) return startEpisode + episode - 1
    if (episode >= startEpisode && episode <= endEpisode) return episode
    if (episode >= 1 && episode <= episodeCount) return startEpisode + episode - 1
    return episode
  }).filter(episode => episode >= startEpisode && episode <= endEpisode))].sort((a, b) => a - b)
}

export async function generateScript(input: ScriptGenerationInput): Promise<GeneratedScript> {
  if (!Number.isInteger(input.episodeCount) || input.episodeCount < 1 || input.episodeCount > MAX_SCRIPT_EPISODES_PER_REQUEST) {
    throw new Error(`单次剧本创作集数必须是 1–${MAX_SCRIPT_EPISODES_PER_REQUEST} 的整数`)
  }

  const systemPrompt = await loadSkillPrompt('drama-script')
  const visualStyle = resolveVideoStylePrompt(input.visualStyle)
  const mode = input.mode ?? 'generate'
  const startEpisode = input.startEpisode ?? 1
  const endEpisode = startEpisode + input.episodeCount - 1
  const existingEpisodeCount = input.existingEpisodes?.length ?? 0
  const sceneCountRange = resolveSceneCountRange(input)
  const sceneCountInstruction = sceneCountRange.source === 'user'
    ? `每集必须为 ${sceneCountRange.min === sceneCountRange.max ? `${sceneCountRange.min} 场` : `${sceneCountRange.min}–${sceneCountRange.max} 场`}，这是用户明确要求`
    : `每集允许 ${MIN_SCRIPT_SCENES}–${MAX_SCRIPT_SCENES} 场完整戏，默认推荐 ${RECOMMENDED_SCRIPT_SCENES} 场；按剧情需要增减但不得越界`
  const plannedEpisodesText = input.plannedEpisodes === null ? '不设定（开放式长剧）' : `${input.plannedEpisodes} 集`
  const shouldFinale = input.isFinale === true
    || (input.plannedEpisodes !== null && endEpisode >= input.plannedEpisodes)
  const existingScript = input.existingEpisodes?.map(episode =>
    `第 ${episode.episodeNumber} 集${episode.title ? `：${episode.title}` : ''}\n${episode.content}`
  ).join('\n\n') ?? ''
  const taskInstruction = mode === 'continue'
    ? `这是续写任务。已有剧本保持不变，只创作第 ${startEpisode}–${endEpisode} 集，并保证人物、设定、时间线和爽点递进连续。`
    : mode === 'rewrite'
      ? `这是指定分集重写任务。只重写第 ${startEpisode}–${endEpisode} 集，其他已有分集不得改写；新内容必须与前后集自然衔接。`
      : `这是首次创作任务。创作第 ${startEpisode}–${endEpisode} 集。`
  const episodeControl = `【集数控制指令】
- 本次生成：第 ${startEpisode} 集到第 ${endEpisode} 集，共 ${input.episodeCount} 集
- 已生成集数：${existingEpisodeCount} 集
- 计划总集数：${plannedEpisodesText}
- 结局要求：${shouldFinale ? `第 ${endEpisode} 集必须是大结局，完整收尾并标记【本剧终】` : '本次最后一集不是大结局，必须保留后续钩子且禁止出现剧终标记'}
- episodeNumber 必须从 ${startEpisode} 连续递增到 ${endEpisode}，只输出本次生成范围
- 单集场戏：${sceneCountInstruction}
- 场号规则：每集 content 内必须从 [1] 开始连续递增，不得重号、跳号或中途重置；同一地点与时间的连续内容必须合并，不得拆场凑数；相邻场次之间必须空一行。
- 空镜名称：scenes[].name 必须以 _黎明/_白天/_黄昏/_夜晚 或允许的完整天气词结尾；正文的 晨/日/昏/夜 必须转换为完整时段词，禁止使用 _晨/_日/_昏/_夜。`
  const sceneCountVerification = sceneCountRange.min === sceneCountRange.max
    ? `写正文前先规划恰好 ${sceneCountRange.min} 个具有真实转场的场次；输出前只按合法场景标注机械计数，第一场必须为 [1]、最后一场必须为 [${sceneCountRange.max}]，总数必须恰好为 ${sceneCountRange.max}。`
    : `写正文前先规划 ${sceneCountRange.min}–${sceneCountRange.max} 个具有真实转场的场次；输出前只按合法场景标注机械计数，并确认场号从 [1] 连续递增。`

  const userPrompt = `请使用本 Skill 完成以下爽剧创作，并严格遵循 Skill 的 JSON 输出契约。

${taskInstruction}

${episodeControl}
${sceneCountVerification}

剧名：${input.title || '由你拟定'}
题材：${input.genre}
画面比例：${input.ratio}
视觉风格：${visualStyle}
已有梗概：${input.synopsis || '无'}
创作需求或原始素材：
${input.brief}
${input.instruction?.trim() ? `\n【本次${mode === 'rewrite' ? '重写' : '续写'}指导】\n${input.instruction.trim()}\n` : ''}
${existingScript ? `\n【全部已有剧本内容】\n${existingScript}` : ''}`
  let generated = await callDeepSeekJson(systemPrompt, userPrompt, generatedScriptSchema, normalizeGeneratedScriptPayload)
  if (generated.episodes.length !== input.episodeCount) {
    throw new Error(`Skill 返回 ${generated.episodes.length} 集，要求为 ${input.episodeCount} 集`)
  }
  let sceneIssues = validateEpisodeScenes(generated.episodes, startEpisode, sceneCountRange)
  if (sceneIssues.length > 0) {
    const correctionPrompt = `${userPrompt}

【上一次输出未通过单集体量检查，必须完整重新创作】
${sceneIssues.map(issue => `- ${issue}`).join('\n')}
- 不得只补场号或把同一连续场景拆开凑数；每一场都要有真实的地点/时间切换和完整戏剧作用。
- 先重做目标数量的场次台账，再完整重写本集；输出前机械计数合法场景标注，并确认最后场号与目标数量一致。
- 重新输出完整 JSON，不要解释修改过程。`
    generated = await callDeepSeekJson(systemPrompt, correctionPrompt, generatedScriptSchema, normalizeGeneratedScriptPayload)
    if (generated.episodes.length !== input.episodeCount) {
      throw new Error(`Skill 纠正后返回 ${generated.episodes.length} 集，要求为 ${input.episodeCount} 集`)
    }
    sceneIssues = validateEpisodeScenes(generated.episodes, startEpisode, sceneCountRange)
    if (sceneIssues.length > 0) throw new Error(`剧本单集体量不合格：${sceneIssues.join('；')}`)
  }
  const orderedEpisodes = [...generated.episodes].sort((a, b) => a.episodeNumber - b.episodeNumber)
  const relativeNumbering = startEpisode > 1
    && orderedEpisodes.every((episode, index) => episode.episodeNumber === index + 1)
  const normalizeReferences = (episodes: number[]) => normalizeGeneratedEpisodeReferences(
    episodes,
    startEpisode,
    input.episodeCount,
    relativeNumbering,
  )
  return {
    project: {
      title: generated.summary.title,
      synopsis: generated.summary.synopsis,
      genre: generated.summary.genre || input.genre,
    },
    episodes: orderedEpisodes.map((episode, index) => ({
      ...episode,
      episodeNumber: startEpisode + index,
      content: normalizeEpisodeSceneSpacing(episode.content),
    })),
    characters: generated.characters.flatMap(character => character.looks.map(look => ({
      name: character.name,
      variant: look.name || '默认形象',
      role: character.role,
      gender: character.gender,
      introduction: character.introduction,
      voiceDescription: look.voiceDescription || character.voiceDescription,
      description: look.description,
      episodes: normalizeReferences(look.episodes),
    }))),
    scenes: generated.scenes.map(scene => ({
      ...scene,
      episodes: normalizeReferences(scene.episodes),
    })),
    props: generated.props.map(prop => ({
      ...prop,
      episodes: normalizeReferences(prop.episodes),
    })),
  }
}

export async function generateStoryboard(input: {
  episodeNumber: number
  episodeTitle: string
  episodeContent: string
  visualStyle: string
  ratio: string
  entities: Array<{
    name: string
    variant: string
    kind: EntityKind
    description: string
    role?: string
    voiceDescription?: string
  }>
}): Promise<GeneratedStoryboard> {
  const systemPrompt = await loadSkillPrompt('drama-shot-prompt')
  const visualStyle = resolveVideoStylePrompt(input.visualStyle)

  const entityText = input.entities.map(entity => {
    const voiceDescription = entity.kind === 'character' ? entity.voiceDescription?.trim() : ''
    const voiceText = voiceDescription ? `；音色描述：${voiceDescription}` : ''
    const tag = getStoryboardReferenceTag(entity)
    const roleText = entity.kind === 'character' && entity.role ? `；角色定位：${entity.role}` : ''
    return `- [${entity.kind}] 可用标签 ${tag}；纯文本名称「${entity.name}」${entity.variant ? `；形象「${entity.variant}」` : ''}${roleText}；描述：${entity.description}${voiceText}`
  }).join('\n')
  const userPrompt = `请使用本 Skill 拆分以下单集剧本。素材引用必须逐字使用“可用素材”清单提供的 @标签，并且每个标签只在“素材引用与主体定义”段出现一次；后续分镜用纯文本名称指代。输出严格遵循 Skill 的 JSON 契约。

第 ${input.episodeNumber} 集：${input.episodeTitle}
画面比例：${input.ratio}
视觉风格：${visualStyle}

可用素材：
${entityText || '暂无素材'}

本集剧本：
${input.episodeContent}`
  const generated = await callDeepSeekJson(systemPrompt, userPrompt, generatedStoryboardSchema)
  return {
    shots: generated.shots
      .sort((a, b) => a.shotOrder - b.shotOrder)
      .map((shot, index) => ({
        shotOrder: index + 1,
        prompt: shot.prompt,
        dialogue: shot.dialogue,
        duration: shot.duration,
      })),
  }
}

/**
 * 开发期真实 Skill 评测使用的 AI 评审。复用与生产文本调用完全相同的
 * DeepSeek JSON、思考、流式接收和最大输出参数，不参与产品运行时流程。
 */
export async function judgeShortDramaSkillQuality(input: {
  caseDescription: string
  scriptBriefResult: unknown
  dramaScriptResult: unknown
  dramaShotPromptResult: unknown
  deterministicReports: unknown
}): Promise<ShortDramaSkillQualityJudgement> {
  const systemPrompt = `你是负责验收竖屏爽剧生产线的资深总编剧、制片导演和 Prompt 质量评审。你的任务是评价三个 Skill 的真实生成结果，而不是继续创作或夸奖模型。

请把结构合法性视为最低门槛，重点检查以下专业质量：
1. script-brief：用户硬约束是否完整保留，人物目标、阻力、失败代价、因果链、爽点升级和关键场景是否具体且可执行，是否越权写成剧本。
2. drama-script：首集钩子是否及时，压迫与反击是否匹配，每场是否产生行动或信息变化，台词是否推进冲突，人物动机和证据链是否连贯，正文是否可见、可听、可拍摄，角色/空镜场景/道具资产是否忠于正文且相互解耦。
3. drama-shot-prompt：是否完整覆盖剧本且没有添加剧情，4–15 秒切分是否符合自然表演，镜头语言、动作起止、空间关系和声音是否可执行，参考资产是否精确绑定，跨 shot 连续性是否稳定。
4. 整体链路：上游信息是否在下游保真传递，最终结果是否达到可继续生成参考图和 Seedance 视频的标准。

阶段输入边界：script-brief 只接收原始创作想法、剧名、题材、视觉风格和比例；当前批次的集数、场次、反击止步点等 scriptInstruction 会由调用方绕过 brief，直接与优化后的 brief 一起传给 drama-script。不要因为 script-brief 没有重复它从未接收的 scriptInstruction 而扣分；只检查这项约束是否在 drama-script 及下游实际落实。

评分必须严格：90–100 为可以直接进入专业生产；75–89 为通过但仍有明确改进点；60–74 为需要改进；0–59 为失败。引用输出中的具体事实作为证据，不要因 JSON 合法或字段齐全自动给高分。

只输出一个符合下列形状的 JSON 对象；字段名和嵌套必须逐字一致，禁止改成 skill_reviews 数组、grade、conclusion、issues 或其他自创结构：
{
  "skills": {
    "scriptBrief": { "score": 0, "strengths": [], "weaknesses": [], "evidence": [] },
    "dramaScript": { "score": 0, "strengths": [], "weaknesses": [], "evidence": [] },
    "dramaShotPrompt": { "score": 0, "strengths": [], "weaknesses": [], "evidence": [] }
  },
  "workflow": {
    "score": 0,
    "verdict": "excellent | pass | needs_improvement | fail",
    "blockingIssues": [],
    "recommendations": []
  }
}
所有 score 替换为 0–100 的整数；verdict 只能取四个英文枚举值之一。`
  const userPrompt = `请评审以下同一次端到端真实调用结果。

【测试案例与硬约束】
${input.caseDescription}

【确定性规则检查】
${JSON.stringify(input.deterministicReports)}

【script-brief 输出】
${JSON.stringify(input.scriptBriefResult)}

【drama-script 输出】
${JSON.stringify(input.dramaScriptResult)}

【drama-shot-prompt 输出】
${JSON.stringify(input.dramaShotPromptResult)}

请分别评价三个 Skill，并给出整条工作流的总体结论。`
  return callDeepSeekJson(systemPrompt, userPrompt, shortDramaSkillQualitySchema)
}
