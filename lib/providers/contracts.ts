export type ProviderAvailability = 'available' | 'degraded' | 'unavailable'
export type ProviderJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface ProviderHealth {
  id: string
  name: string
  availability: ProviderAvailability
  endpoint?: string
  version?: string
  latencyMs?: number
  message?: string
  capabilities?: Record<string, unknown>
  checkedAt: string
}

export interface ProviderJob<TOutput> {
  id: string
  state: ProviderJobState
  progress?: number
  output?: TOutput
  error?: string
}

export interface HealthCheckableProvider {
  readonly id: string
  health(): Promise<ProviderHealth>
}

export interface TextGenerationRequest {
  systemPrompt: string
  userPrompt: string
  responseSchemaName: string
  responseJsonSchema: Record<string, unknown>
}

export interface TextGenerationProvider extends HealthCheckableProvider {
  generateStructured<T>(request: TextGenerationRequest): Promise<T>
}

export interface VideoGenerationRequest {
  referenceImagePaths: string[]
  prompt: string
  width: number
  height: number
  duration: number
  seed: number
  model: string
  presetId: string
  turboMode: boolean
}

export interface VideoGenerationOutput {
  path: string
  mimeType: 'video/mp4'
  width?: number
  height?: number
  duration?: number
  seed?: number
}

export interface VideoGenerationProvider extends HealthCheckableProvider {
  submit(request: VideoGenerationRequest): Promise<ProviderJob<VideoGenerationOutput>>
  getJob(jobId: string): Promise<ProviderJob<VideoGenerationOutput>>
}

export interface SpeechSynthesisRequest {
  text: string
  language: 'ar'
  voiceReferencePath?: string
  voiceReferenceTranscript?: string
  model: string
  outputPath: string
}

export interface SpeechSynthesisOutput {
  path: string
  mimeType: 'audio/wav'
  duration?: number
}

export interface SpeechSynthesisProvider extends HealthCheckableProvider {
  synthesize(request: SpeechSynthesisRequest): Promise<ProviderJob<SpeechSynthesisOutput>>
  getJob(jobId: string): Promise<ProviderJob<SpeechSynthesisOutput>>
}

export interface LipSyncRequest {
  videoPath: string
  audioPath: string
  outputPath: string
}

export interface LipSyncOutput {
  path: string
  mimeType: 'video/mp4'
}

export interface LipSyncProvider extends HealthCheckableProvider {
  submit(request: LipSyncRequest): Promise<ProviderJob<LipSyncOutput>>
  getJob(jobId: string): Promise<ProviderJob<LipSyncOutput>>
}
