import { globalShortcut } from 'electron'
import { parseCues } from '../shared/cues.js'
import { sendDeckKey } from './presentation.js'
import { DEFAULT_HOTKEYS, type AppState, type HotkeyCommand } from '../shared/types.js'
import { getState, setState } from './store.js'
import { applyOverlayEffects, broadcastState, createOverlay, getWindows } from './windows.js'

const CLICKER_BINDINGS = ['PageDown', 'PageUp']
let clickerActive = false

const failedAccelerators = new Set<string>()

export function getHotkeyStatus(): { failed: string[] } {
  return { failed: Array.from(failedAccelerators) }
}

function tryRegister(accel: string, fn: () => void) {
  if (!accel) {
    failedAccelerators.add('(empty)')
    return
  }
  try {
    const ok = globalShortcut.register(accel, fn)
    if (!ok) failedAccelerators.add(accel)
    else failedAccelerators.delete(accel)
  } catch {
    failedAccelerators.add(accel)
  }
}

function bindingsFromState(): Record<HotkeyCommand, string> {
  const fromState = getState().hotkeyBindings
  return { ...DEFAULT_HOTKEYS, ...(fromState || {}) }
}

export function registerHotkeys() {
  globalShortcut.unregisterAll()
  failedAccelerators.clear()
  clickerActive = false
  const bindings = bindingsFromState()
  for (const cmd of Object.keys(bindings) as HotkeyCommand[]) {
    const accel = bindings[cmd]
    if (!accel) continue
    tryRegister(accel, () => handle(cmd))
  }
  for (let i = 1; i <= 9; i++) {
    tryRegister(`CommandOrControl+Alt+${i}`, () => jumpToCue(i - 1))
  }
  syncClickerHotkeys(getState().clickerMode)
}

export function rebindHotkeys() {
  registerHotkeys()
}

export function unregisterHotkeys() {
  globalShortcut.unregisterAll()
  clickerActive = false
  failedAccelerators.clear()
}

export function syncClickerHotkeys(enabled: boolean) {
  if (enabled === clickerActive) return
  if (enabled) {
    tryRegister('PageDown', () => stepScroll(+1))
    tryRegister('PageUp', () => stepScroll(-1))
  } else {
    for (const k of CLICKER_BINDINGS) {
      globalShortcut.unregister(k)
      failedAccelerators.delete(k)
    }
  }
  clickerActive = enabled
}

function stepScroll(direction: 1 | -1) {
  const s = getState()
  const next = Math.max(0, Math.min(1, s.scrollPosition + direction * s.clickerStep))
  apply({ scrollPosition: next })
  if (s.drivePresentation) sendDeckKey(direction === 1 ? 'advance' : 'back')
}

function jumpToCue(idx: number) {
  const s = getState()
  const file = s.files[s.currentFileIndex]
  if (!file) return
  const cues = parseCues(file.content)
  const cue = cues[idx]
  if (!cue) return
  apply({ scrollPosition: cue.position })
}

function handle(cmd: HotkeyCommand) {
  const state = getState()
  switch (cmd) {
    case 'play-pause':
      apply({ playing: !state.playing })
      break
    case 'speed-up':
      apply({ scrollSpeed: Math.min(400, state.scrollSpeed + 10) })
      break
    case 'speed-down':
      apply({ scrollSpeed: Math.max(5, state.scrollSpeed - 10) })
      break
    case 'opacity-up':
      apply({ opacity: Math.min(1, +(state.opacity + 0.05).toFixed(2)) })
      break
    case 'opacity-down':
      apply({ opacity: Math.max(0.05, +(state.opacity - 0.05).toFixed(2)) })
      break
    case 'next-file':
      if (state.files.length)
        apply({
          currentFileIndex: (state.currentFileIndex + 1) % state.files.length,
          scrollPosition: 0,
        })
      break
    case 'prev-file':
      if (state.files.length)
        apply({
          currentFileIndex: (state.currentFileIndex - 1 + state.files.length) % state.files.length,
          scrollPosition: 0,
        })
      break
    case 'toggle-overlay': {
      const win = getWindows().overlay
      if (!win || win.isDestroyed()) {
        createOverlay()
      } else if (win.isVisible()) {
        win.hide()
      } else {
        win.show()
      }
      break
    }
    case 'toggle-click-through':
      apply({ clickThrough: !state.clickThrough })
      break
    case 'restart':
      apply({ scrollPosition: 0, playing: false })
      break
  }
}

function apply(patch: Partial<AppState>) {
  const next = setState(patch)
  applyOverlayEffects()
  broadcastState(next)
}
