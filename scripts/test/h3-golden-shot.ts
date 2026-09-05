import { strict as assert } from 'node:assert'
import { promisify } from 'node:util'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { addShotVideo, createEpisode, createProject, createShot, getShot, markShotGenerating, markShotSubmitting, updateEpisode, updateShot } from '@/lib/db'
import { getH3Preset } from '@/lib/h3-presets'
import { buildH3ApiWorkflow, localComfyUIProvider, WORKFLOW_VERSION } from '@/lib/providers/comfyui'
import { resolveMediaPath } from '@/lib/local-media'

const execFile = promisify(execFileCallback)

const WIDTH = 608
const HEIGHT = 352
const DURATION = 3
const SEED = 123456
const PRESET_ID = 'fl2va-turbo-4' as const
const MODEL = 'MiniMax-H3/minimax_h3_fl2va_pruned_int8_convrot.safetensors'
const PROMPT = 'A fixed golden-shot contract test frame, a Saudi woman stands in a sunlit courtyard and turns toward camera, cinematic motion.'
const MAX_WAIT_MS = 10 * 60 * 1000
const POLL_MS = 2_000
const KEEP_DATA = process.env.H3_GOLDEN_KEEP === '1'

type ProbeStream = {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
}

type ProbeResult = { streams?: ProbeStream[]; format?: { duration?: string } }

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
  return Buffer.concat([length, typeBuffer, data, checksum])
}

function createReferencePng(): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(WIDTH, 0)
  header.writeUInt32BE(HEIGHT, 4)
  header[8] = 8
  header[9] = 2
  const rows: Buffer[] = []
  for (let y = 0; y < HEIGHT; y += 1) {
    const row = Buffer.alloc(1 + WIDTH * 3)
    row[0] = 0
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = 1 + x * 3
      row[offset] = (x * 255) / WIDTH
      row[offset + 1] = (y * 255) / HEIGHT
      row[offset + 2] = 180
    }
    rows.push(row)
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function parseFps(value: string | undefined): number {
  if (!value) return Number.NaN
  const [numerator, denominator] = value.split('/').map(Number)
  return denominator ? numerator / denominator : Number(value)
}

async function probeVideo(videoPath: string): Promise<ProbeResult> {
  const { stdout } = await execFile('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate',
    '-show_entries', 'format=duration',
    '-of', 'json',
    videoPath,
  ])
  return JSON.parse(stdout) as ProbeResult
}

async function waitForVideo(jobId: string) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < MAX_WAIT_MS) {
    const job = await localComfyUIProvider.getJob(jobId)
    console.log(`  ComfyUI job ${jobId}: ${job.state}`)
    if (job.state === 'succeeded') {
      assert.ok(job.output?.path, 'ComfyUI succeeded without a local MP4 path')
      return job.output.path
    }
    if (job.state === 'failed' || job.state === 'cancelled') {
      throw new Error(`ComfyUI golden shot failed: ${job.error ?? job.state}`)
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
  throw new Error(`ComfyUI golden shot timed out after ${MAX_WAIT_MS / 1000}s`)
}

async function main() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'arabic-short-drama-h3-golden-'))
  process.env.DATA_DIR = dataDir
  const referencePath = 'uploads/golden-reference.png'
  const referenceAbsolutePath = path.join(dataDir, 'media', referencePath)
  await mkdir(path.dirname(referenceAbsolutePath), { recursive: true })
  await writeFile(referenceAbsolutePath, createReferencePng())

  try {
    const project = createProject({ title: 'H3 Golden Shot Contract' })
    const episode = createEpisode(project.id)
    updateEpisode(episode.id, { title: 'Golden shot', content: '固定验收镜头', status: 'confirmed' })
    const shot = createShot(project.id, episode.id)
    const configuredShot = updateShot(shot.id, {
      prompt: PROMPT,
      referenceImagePath: referencePath,
      width: WIDTH,
      height: HEIGHT,
      duration: DURATION,
      seed: SEED,
      h3Model: MODEL,
      h3Preset: PRESET_ID,
      turboMode: true,
      videoProvider: 'local-comfyui',
    })!
    const request = {
      referenceImagePaths: [referencePath],
      prompt: PROMPT,
      width: WIDTH,
      height: HEIGHT,
      duration: DURATION,
      seed: SEED,
      model: MODEL,
      presetId: PRESET_ID,
      turboMode: true,
    }

    const workflow = await buildH3ApiWorkflow(request, ['ai-short-drama/golden-reference.png'])
    assert.equal(workflow['2']?.inputs.width, WIDTH)
    assert.equal(workflow['2']?.inputs.height, HEIGHT)
    assert.equal(workflow['2']?.inputs.seconds, DURATION)
    assert.equal(workflow['2']?.inputs.aspect_ratio, '16:9')
    assert.equal(workflow['5']?.inputs.steps, getH3Preset(PRESET_ID).steps)
    assert.equal(workflow['6']?.inputs.noise_seed, SEED)
    assert.equal(workflow['2']?.inputs.fps, 24)
    console.log('✓ workflow maps width, height, duration, fps, seed and Turbo 4 preset')

    markShotSubmitting(configuredShot.id)
    const job = await localComfyUIProvider.submit(request)
    markShotGenerating(configuredShot.id, job.id, MODEL, `${WIDTH}x${HEIGHT}`, WORKFLOW_VERSION)
    const outputPath = await waitForVideo(job.id)
    const completedShot = addShotVideo(configuredShot.id, {
      path: outputPath,
      providerTaskId: job.id,
      provider: 'local-comfyui',
      model: MODEL,
      preset: PRESET_ID,
      width: WIDTH,
      height: HEIGHT,
      seed: SEED,
      workflowVersion: WORKFLOW_VERSION,
      referenceImagePath: referencePath,
      duration: DURATION,
      resolution: `${WIDTH}x${HEIGHT}`,
    })
    const selectedVideo = completedShot.selectedVideo
    assert.ok(selectedVideo?.path, 'database did not select the generated video')
    assert.equal(completedShot.width, WIDTH)
    assert.equal(completedShot.height, HEIGHT)
    assert.equal(completedShot.duration, DURATION)
    assert.equal(completedShot.seed, SEED)
    assert.equal(completedShot.h3Model, MODEL)
    assert.equal(completedShot.h3Preset, PRESET_ID)
    assert.equal(completedShot.turboMode, true)
    assert.equal(selectedVideo.width, WIDTH)
    assert.equal(selectedVideo.height, HEIGHT)
    assert.equal(selectedVideo.duration, DURATION)
    assert.equal(selectedVideo.seed, SEED)
    assert.equal(selectedVideo.model, MODEL)
    assert.equal(selectedVideo.preset, PRESET_ID)
    assert.equal(selectedVideo.provider, 'local-comfyui')
    assert.equal(selectedVideo.workflowVersion, WORKFLOW_VERSION)
    console.log('✓ database shot and video snapshot match the fixed request')

    const probe = await probeVideo(resolveMediaPath(selectedVideo.path))
    const videoStream = probe.streams?.find(stream => stream.codec_type === 'video')
    const audioStream = probe.streams?.find(stream => stream.codec_type === 'audio')
    assert.equal(videoStream?.codec_name, 'h264')
    assert.equal(audioStream?.codec_name, 'aac')
    assert.equal(videoStream?.width, WIDTH)
    assert.equal(videoStream?.height, HEIGHT)
    assert.equal(parseFps(videoStream?.avg_frame_rate ?? videoStream?.r_frame_rate), 24)
    const actualDuration = Number(probe.format?.duration)
    assert.ok(Number.isFinite(actualDuration) && Math.abs(actualDuration - DURATION) <= 0.35, `expected duration near ${DURATION}s, got ${actualDuration}s`)
    console.log(`✓ ffprobe: ${WIDTH}x${HEIGHT}, ${actualDuration.toFixed(3)}s, 24fps, H.264/AAC`)
    console.log(`Golden shot passed. DATA_DIR=${dataDir}`)
  } catch (error) {
    console.error(`Golden shot failed. DATA_DIR=${dataDir}`)
    throw error
  } finally {
    if (!KEEP_DATA) await rm(dataDir, { recursive: true, force: true })
  }
}

void main().catch(() => process.exitCode = 1)
