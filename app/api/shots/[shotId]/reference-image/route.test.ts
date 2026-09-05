import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getShot: vi.fn(),
  updateShot: vi.fn(),
  saveDataUrl: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ getShot: mocks.getShot, updateShot: mocks.updateShot }))
vi.mock('@/lib/local-media', () => ({ saveDataUrl: mocks.saveDataUrl }))

import { POST } from './route'

const shot = { id: 'shot-1', status: 'pending' }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.getShot.mockReturnValue(shot)
  mocks.saveDataUrl.mockResolvedValue('uploads/reference.webp')
  mocks.updateShot.mockReturnValue({ ...shot, referenceImagePath: 'uploads/reference.webp' })
})

describe('shot reference image upload', () => {
  it('persists the upload in local media and binds its relative path', async () => {
    const request = new Request('http://localhost/api/shots/shot-1/reference-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl: 'data:image/webp;base64,AAAAAA==' }),
    })
    const response = await POST(request, { params: Promise.resolve({ shotId: 'shot-1' }) })
    expect(response.status).toBe(200)
    expect(mocks.saveDataUrl).toHaveBeenCalledWith('data:image/webp;base64,AAAAAA==', 'uploads')
    expect(mocks.updateShot).toHaveBeenCalledWith('shot-1', { referenceImagePath: 'uploads/reference.webp' })
  })

  it('blocks replacement while generation is running', async () => {
    mocks.getShot.mockReturnValue({ ...shot, status: 'generating' })
    const request = new Request('http://localhost', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: 'data:image/webp;base64,AAAAAA==' }),
    })
    const response = await POST(request, { params: Promise.resolve({ shotId: 'shot-1' }) })
    expect(response.status).toBe(409)
    expect(mocks.saveDataUrl).not.toHaveBeenCalled()
  })
})
