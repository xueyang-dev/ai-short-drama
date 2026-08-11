import { afterEach, describe, expect, it, vi } from 'vitest'

const mediaMocks = vi.hoisted(() => ({
  fileToDataUrl: vi.fn(),
  saveDataUrl: vi.fn(),
}))

vi.mock('../local-media', () => mediaMocks)

import { generateSeedreamImage } from './seedream'

afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('Seedream provider', () => {
  it('发送当前完整请求契约并解析 Base64 结果', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      data: [{ b64_json: 'generated-image' }],
    }), { status: 200 }))
    vi.stubEnv('VOLCENGINE_API_KEY', 'test-key')
    vi.stubGlobal('fetch', fetchMock)
    mediaMocks.fileToDataUrl.mockResolvedValue('data:image/png;base64,reference-image')
    mediaMocks.saveDataUrl.mockResolvedValue('images/generated.png')

    await expect(generateSeedreamImage({
      prompt: '角色完整提示词',
      ratio: '1:1',
      referencePath: 'images/reference.png',
    })).resolves.toEqual({ path: 'images/generated.png', prompt: '角色完整提示词' })

    const request = fetchMock.mock.calls[0]
    const body = JSON.parse(String(request?.[1]?.body)) as Record<string, unknown>
    expect(request?.[0]).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations')
    expect(request?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(body).toEqual({
      model: 'doubao-seedream-5-0-260128',
      prompt: '角色完整提示词',
      size: '2048x2048',
      sequential_image_generation: 'disabled',
      response_format: 'b64_json',
      output_format: 'png',
      watermark: false,
      optimize_prompt_options: { mode: 'standard' },
      image: 'data:image/png;base64,reference-image',
    })
    expect(mediaMocks.saveDataUrl).toHaveBeenCalledWith('data:image/png;base64,generated-image', 'images')
  })

  it('优先返回响应条目中的具体错误', async () => {
    vi.stubEnv('VOLCENGINE_API_KEY', 'test-key')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ error: { message: '参考图不符合要求' } }],
    }), { status: 200 })))

    await expect(generateSeedreamImage({ prompt: '道具提示词', ratio: '1:1' }))
      .rejects.toThrow('参考图不符合要求')
    expect(mediaMocks.saveDataUrl).not.toHaveBeenCalled()
  })
})
