export function localServiceUrl(value: string, fallback: string): URL {
  const url = new URL(value || fallback)
  const hostname = url.hostname.toLowerCase()
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
    throw new Error(`本地 Provider 只允许 localhost HTTP 地址：${url.origin}`)
  }
  return url
}

export function providerEndpoint(envName: string, fallback: string): URL {
  return localServiceUrl(process.env[envName] || fallback, fallback)
}
