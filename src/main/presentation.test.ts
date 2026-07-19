import { describe, expect, it, vi } from 'vitest'
import { PresentationDriver } from './presentation.js'

describe('presentation driver', () => {
  it('declares truthful platform and display-server capabilities', () => {
    expect(
      new PresentationDriver({ platform: 'win32', displayServer: 'win32' }).capability(),
    ).toEqual({ ok: false, reason: 'Linux only in v1' })
    expect(
      new PresentationDriver({ platform: 'linux', displayServer: 'wayland' }).capability(),
    ).toEqual({ ok: false, reason: 'Wayland not supported (X11 only via xdotool)' })
    expect(
      new PresentationDriver({
        platform: 'linux',
        displayServer: 'x11',
        findXdotool: () => null,
      }).capability(),
    ).toEqual({ ok: false, reason: 'xdotool not installed — sudo apt install xdotool' })
  })

  it('attaches an error listener before detaching the trusted xdotool child', () => {
    const order: string[] = []
    const spawnChild = vi.fn(() => ({
      once: vi.fn((event: string) => order.push(`listen:${event}`)),
      unref: vi.fn(() => order.push('unref')),
    }))
    const driver = new PresentationDriver({
      platform: 'linux',
      displayServer: 'x11',
      findXdotool: () => '/usr/bin/xdotool',
      spawnChild,
    })

    driver.sendKey('advance')

    expect(spawnChild).toHaveBeenCalledWith(
      '/usr/bin/xdotool',
      ['key', '--clearmodifiers', 'Right'],
    )
    expect(order).toEqual(['listen:error', 'unref'])
  })
})
