import { describe, expect, it } from 'vitest'
import { IPC_POLICY, authorizeIpc } from './ipc-policy.js'

describe('IPC authorization manifest', () => {
  it('gives the overlay no file, settings, hotkey, or integration authority', () => {
    const overlayChannels = Object.entries(IPC_POLICY)
      .filter(([, policy]) => (policy.roles as readonly string[]).includes('overlay'))
      .map(([channel]) => channel)
    expect(overlayChannels).not.toContain('documents:open')
    expect(overlayChannels).not.toContain('documents:save')
    expect(overlayChannels).not.toContain('preferences:import')
    expect(overlayChannels).not.toContain('hotkeys:update')
    expect(overlayChannels).not.toContain('voice:request')
  })

  it('authorizes only declared role, exact top-frame URL, and main frame', () => {
    const expectedUrl = 'file:///app/out/renderer/controls.html'
    expect(
      authorizeIpc('documents:save', {
        role: 'controls',
        frameUrl: expectedUrl,
        expectedUrl,
        isMainFrame: true,
      }),
    ).toBe(true)
    expect(
      authorizeIpc('documents:save', {
        role: 'overlay',
        frameUrl: 'file:///app/out/renderer/overlay.html',
        expectedUrl: 'file:///app/out/renderer/overlay.html',
        isMainFrame: true,
      }),
    ).toBe(false)
    expect(
      authorizeIpc('documents:save', {
        role: 'controls',
        frameUrl: 'file:///tmp/attacker/controls.html',
        expectedUrl,
        isMainFrame: true,
      }),
    ).toBe(false)
    expect(
      authorizeIpc('documents:save', {
        role: 'controls',
        frameUrl: expectedUrl,
        expectedUrl,
        isMainFrame: false,
      }),
    ).toBe(false)
  })

  it('allows shared bootstrap and playback toggle but keeps overlay-only reporting separate', () => {
    expect(IPC_POLICY['app:bootstrap'].roles).toEqual(['controls', 'overlay'])
    expect(IPC_POLICY['playback:toggle'].roles).toEqual(['controls', 'overlay'])
    expect(IPC_POLICY['playback:checkpoint'].roles).toEqual(['overlay'])
    expect(IPC_POLICY['overlay:dragStart'].roles).toEqual(['overlay'])
  })
})
