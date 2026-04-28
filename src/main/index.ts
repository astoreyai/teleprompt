import { app, BrowserWindow, session } from 'electron'
import { existsSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'
import { registerHotkeys, unregisterHotkeys } from './hotkeys.js'
import { loadPathOnStartup, registerIpc } from './ipc.js'
import { flushPersist } from './store.js'
import {
  applyOverlayEffects,
  createControls,
  createOverlay,
  getWindows,
  stopCursorPoll,
  stopTopReassertPoll,
} from './windows.js'

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
