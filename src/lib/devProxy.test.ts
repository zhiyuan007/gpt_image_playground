import { describe, expect, it } from 'vitest'
import { buildApiUrl } from './devProxy'
import { shouldBypassServiceWorkerCache } from './serviceWorkerCache'

describe('buildApiUrl', () => {
  it('uses the same-origin proxy prefix when API proxy is enabled', () => {
    expect(buildApiUrl('http://api.example.com/v1', 'images/edits', null, true)).toBe(
      '/api-proxy/images/edits',
    )
  })

  it('leaves API versioning to the proxy target when proxying', () => {
    expect(buildApiUrl('http://api.example.com', 'images/generations', null, true)).toBe(
      '/api-proxy/images/generations',
    )
  })

  it('uses a configured proxy prefix when one is available', () => {
    expect(
      buildApiUrl(
        'http://api.example.com/v1',
        'responses',
        {
          enabled: true,
          prefix: '/openai-proxy',
          target: 'http://api.example.com/v1',
          changeOrigin: true,
          secure: false,
        },
        true,
      ),
    ).toBe('/openai-proxy/responses')
  })

  it('uses the configured API URL directly when API proxy is disabled', () => {
    expect(buildApiUrl('http://api.example.com/v1', 'responses', null, false)).toBe(
      'http://api.example.com/v1/responses',
    )
  })
})

describe('shouldBypassServiceWorkerCache', () => {
  it('bypasses same-origin hosted auth status requests', () => {
    expect(shouldBypassServiceWorkerCache({
      method: 'GET',
      mode: 'same-origin',
      url: 'https://image.pumpkinheadgame.com/api/job-auth/status',
    }, 'https://image.pumpkinheadgame.com')).toBe(true)
  })

  it('bypasses same-origin hosted job health requests', () => {
    expect(shouldBypassServiceWorkerCache({
      method: 'GET',
      mode: 'same-origin',
      url: 'https://image.pumpkinheadgame.com/api/image-jobs/health',
    }, 'https://image.pumpkinheadgame.com')).toBe(true)
  })

  it('keeps same-origin static assets cacheable', () => {
    expect(shouldBypassServiceWorkerCache({
      method: 'GET',
      mode: 'no-cors',
      url: 'https://image.pumpkinheadgame.com/assets/index.js',
    }, 'https://image.pumpkinheadgame.com')).toBe(false)
  })
})
