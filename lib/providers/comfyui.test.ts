import { describe, expect, it } from 'vitest'
import { buildH3ApiWorkflow } from './comfyui'

const request = {
  referenceImagePaths: ['uploads/reference.png'],
  prompt: 'A cinematic Saudi drama shot',
  width: 768,
  height: 1280,
  duration: 5,
  seed: 123456,
  model: 'MiniMax-H3/minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  presetId: 'fl2va-turbo-4' as const,
  turboMode: true,
}

describe('Local ComfyUI H3 API workflow', () => {
  it('renders the Turbo 4 API graph with explicit shot parameters', async () => {
    const workflow = await buildH3ApiWorkflow(request, ['ai-short-drama/reference.png'])
    expect(workflow['1'].inputs.fl2va_model).toBe(request.model)
    expect(workflow['1'].inputs.ref2va_model).toBe('无')
    expect(workflow['2'].inputs).toMatchObject({
      mode: 'image', prompt: request.prompt, width: 768, height: 1280, seconds: 5,
    })
    expect(workflow['5'].inputs.steps).toBe(4)
    expect(workflow['6'].inputs.noise_seed).toBe(123456)
    expect(workflow['24'].inputs.lora_name).toContain('turbo_4step')
    expect(workflow['100']).toEqual({ class_type: 'LoadImage', inputs: { image: 'ai-short-drama/reference.png' } })
  })

  it('removes the LoRA node for base and rewires the model', async () => {
    const workflow = await buildH3ApiWorkflow({
      ...request,
      presetId: 'fl2va-base',
      turboMode: false,
    }, ['reference.png'])
    expect(workflow['24']).toBeUndefined()
    expect(workflow['34'].inputs.model).toEqual(['2', 0])
    expect(workflow['5'].inputs.steps).toBe(20)
  })

  it('builds a REF2VA graph with multiple references', async () => {
    const workflow = await buildH3ApiWorkflow({
      ...request,
      referenceImagePaths: ['one.png', 'two.png'],
      model: 'MiniMax-H3/minimax_h3_ref2va_pruned_int8_convrot.safetensors',
      presetId: 'ref2va',
      turboMode: false,
    }, ['one.png', 'two.png'])
    expect(workflow['1'].inputs.fl2va_model).toBe('无')
    expect(workflow['1'].inputs.ref2va_model).toContain('ref2va')
    expect(workflow['2'].inputs.mode).toBe('reference')
    expect(workflow['14'].inputs).toMatchObject({ image_count: 2, image_1: ['100', 0], image_2: ['101', 0] })
  })
})
