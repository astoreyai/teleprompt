import { app, BrowserWindow, crashReporter, session } from 'electron'
import { existsSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'
import { registerHotkeys, unregisterHotkeys } from './hotkeys.js'
import { loadPathOnStartup, registerIpc } from './ipc.js'
import { logCrash } from './log.js'
import { flushPersist } from './store.js'
import {
  applyOverlayEffects,
  createControls,
  createOverlay,
  getWindows,
  stopCursorPoll,
  stopTopReassertPoll,
} from './windows.js'

// --- Stability hardening (must run before app 'ready') ---

// GPU/compositor faults are the most common native-crash source for Electron
// on Linux, and a teleprompter gains nothing from hardware compositing.
// Disable it by default; TELEPROMPT_HWACCEL=1 forces it back on (debug/compare).
if (!process.env.TELEPROMPT_HWACCEL) {
  app.disableHardwareAcceleration()
}

// Write local minidumps (never uploaded) so hard crashes are diagnosable.
try {
  crashReporter.start({ uploadToServer: false })
} catch (e) {
  logCrash(`crashReporter.start failed: ${e instanceof Error ? e.message : String(e)}`)
}

// Log unexpected JS faults instead of letting a stray throw take the app down.
process.on('uncaughtException', (err) => {
  logCrash(`uncaughtException: ${err?.stack ?? String(err)}`)
})
process.on('unhandledRejection', (reason) => {
  logCrash(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`)
})

const ALLOWED_EXTS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.rtf',
  '.docx',
  '.odt',
  '.pdf',
  '.html',
  '.htm',
  '.fountain',
  '.srt',
  '.vtt',
])

function pickFileArgs(argv: string[]): string[] {
  const out: string[] = []
  for (const a of argv.slice(1)) {
    if (a.startsWith('-')) continue
    const abs = isAbsolute(a) ? a : resolve(a)
    if (!existsSync(abs)) continue
    if (ALLOWED_EXTS.has(extname(abs).toLowerCase())) out.push(abs)
  }
  return out
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.on('second-instance', async (_e, argv) => {
  const { controls } = getWindows()
  if (controls && !controls.isDestroyed()) {
    if (controls.isMinimized()) controls.restore()
    controls.focus()
  }
  for (const path of pickFileArgs(argv)) {
    await loadPathOnStartup(path)
  }
})

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })
  registerIpc()
  createOverlay()
  createControls()
  registerHotkeys()
  applyOverlayEffects()
  for (const path of pickFileArgs(process.argv)) {
    await loadPathOnStartup(path)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createOverlay()
      createControls()
    }
  })
})

app.on('will-quit', () => {
  unregisterHotkeys()
  stopCursorPoll()
  stopTopReassertPoll()
  flushPersist()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
