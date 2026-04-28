import { execSync, spawn } from 'node:child_process'

export type Capability = { ok: boolean; reason?: string }

let xdotoolCached: boolean | null = null

function hasXdotool(): boolean {
  if (xdotoolCached !== null) return xdotoolCached
  try {
    execSync('which xdotool', { stdio: 'ignore' })
    xdotoolCached = true
  } catch {
    xdotoolCached = false
  }
  return xdotoolCached
}

export function presentationCapability(): Capability {
  if (process.platform !== 'linux') {
    return { ok: false, reason: 'Linux only in v1' }
  }
  const session = process.env.XDG_SESSION_TYPE
  if (session === 'wayland') {
    return { ok: false, reason: 'Wayland not supported (X11 only via xdotool)' }
  }
  if (!hasXdotool()) {
    return { ok: false, reason: 'xdotool not installed — sudo apt install xdotool' }
  }
  return { ok: true }
}

export function sendDeckKey(direction: 'advance' | 'back'): void {
  if (!presentationCapability().ok) return
  const key = direction === 'advance' ? 'Right' : 'Left'
  try {
    const child = spawn('xdotool', ['key', '--clearmodifiers', key], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
  } catch {
    /* swallow — capability check is best-effort */
  }
}
