import { describe, expect, it } from 'vitest'
import { localServiceUrl } from './local-url'

describe('local provider URL boundary', () => {
  it.each(['http://127.0.0.1:8188', 'http://localhost:8190', 'http://[::1]:8189'])(
    'accepts loopback endpoint %s',
    endpoint => expect(localServiceUrl(endpoint, endpoint).origin).toBe(new URL(endpoint).origin),
  )

  it.each(['https://localhost:8188', 'http://192.168.1.10:8188', 'https://example.com'])(
    'rejects non-local or TLS endpoint %s',
    endpoint => expect(() => localServiceUrl(endpoint, 'http://127.0.0.1')).toThrow('localhost HTTP'),
  )
})
