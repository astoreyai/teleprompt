import { constants } from 'node:fs'
import { accessSync, realpathSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'

export type Capability = { ok: boolean; reason?: string }

type DetachedChild = {
  once(event: 'error', listener: (error: Error) => void): unknown
  unref(): void
}

type PresentationDriverOptions = {
  platform?: NodeJS.Platform
  displayServer?: string
  findXdotool?: () => string | null
  spawnChild?: (executable: string, arguments_: string[]) => DetachedChild
}

export class PresentationDriver {
  private readonly platform: NodeJS.Platform
  private readonly displayServer: string | undefined
  private readonly findXdotool: () => string | null
  private readonly spawnChild: (executable: string, arguments_: string[]) => DetachedChild
  private xdotoolPath: string | null | undefined

  constructor(options: PresentationDriverOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.displayServer = options.displayServer ?? process.env.XDG_SESSION_TYPE
    this.findXdotool = options.findXdotool ?? findTrustedXdotool
    this.spawnChild = options.spawnChild ?? ((executable, arguments_) =>
      spawn(executable, arguments_, { detached: true, stdio: 'ignore' }))
  }

  capability(): Capability {
    if (this.platform !== 'linux') return { ok: false, reason: 'Linux only in v1' }
    if (this.displayServer === 'wayland') {
      return { ok: false, reason: 'Wayland not supported (X11 only via xdotool)' }
    }
    if (!this.executable()) {
      return { ok: false, reason: 'xdotool not installed — sudo apt install xdotool' }
    }
    return { ok: true }
  }

  sendKey(direction: 'advance' | 'back'): void {
    if (!this.capability().ok) return
    const executable = this.executable()
    if (!executable) return
    const key = direction === 'advance' ? 'Right' : 'Left'
    try {
      const child = this.spawnChild(executable, ['key', '--clearmodifiers', key])
      child.once('error', () => undefined)
      child.unref()
    } catch {
      // Presentation integration is best-effort and cannot take down prompting.
    }
  }

  private executable(): string | null {
    if (this.xdotoolPath === undefined) this.xdotoolPath = this.findXdotool()
    return this.xdotoolPath
  }
}

function findTrustedXdotool(): string | null {
  for (const candidate of [
    '/usr/bin/xdotool',
    '/bin/xdotool',
    '/usr/local/bin/xdotool',
    '/run/current-system/sw/bin/xdotool',
  ]) {
    try {
      const path = realpathSync(candidate)
      if (!statSync(path).isFile()) continue
      accessSync(path, constants.X_OK)
      return path
    } catch {
      // Try the next system installation path.
    }
  }
  return null
}

const defaultDriver = new PresentationDriver()

export function presentationCapability(): Capability {
  return defaultDriver.capability()
}

export function sendDeckKey(direction: 'advance' | 'back'): void {
  defaultDriver.sendKey(direction)
}
