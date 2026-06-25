interface CacheableRequestLike {
  method: string
  mode?: string
  url: string
}

export function shouldBypassServiceWorkerCache(
  request: CacheableRequestLike,
  scopeOrigin: string,
): boolean {
  if (request.method !== 'GET') return true

  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return true
  }

  if (url.origin !== scopeOrigin) return true
  if (request.mode === 'navigate') return false

  return url.pathname.startsWith('/api/')
}
