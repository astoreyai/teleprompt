import { describe, expect, it } from 'vitest'
import { resolveRendererRequestPath } from './renderer-route.js'

describe('resolveRendererRequestPath', () => {
  it('maps app routes into the packaged renderer directory', () => {
    expect(resolveRendererRequestPath('/opt/teleprompt/renderer', 'teleprompt://app/controls.html'))
      .toBe('/opt/teleprompt/renderer/controls.html')
    expect(resolveRendererRequestPath('/opt/teleprompt/renderer', 'teleprompt://app/assets/main.js'))
      .toBe('/opt/teleprompt/renderer/assets/main.js')
  })

  it('rejects other hosts, malformed escapes, and traversal', () => {
    expect(resolveRendererRequestPath('/opt/teleprompt/renderer', 'teleprompt://other/controls.html')).toBeNull()
    expect(resolveRendererRequestPath('/opt/teleprompt/renderer', 'teleprompt://app/%2e%2e/secrets')).toBeNull()
    expect(resolveRendererRequestPath('/opt/teleprompt/renderer', 'teleprompt://app/%ZZ')).toBeNull()
  })
})
