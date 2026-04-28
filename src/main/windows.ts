import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getState, setState } from './store.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const PRELOAD = join(__dirname, '../preload/index.js')
const RENDERER_DEV = process.env.ELECTRON_RENDERER_URL
const RENDERER_DIST = join(__dirname, '../renderer')

export type Windows = {
  overlay?: BrowserWindow
  controls?: BrowserWindow
}

const windows: Windows = {}

export function getWindows(): Windows {
  return windows
}

export function createOverlay(): BrowserWindow {
  const { overlayBounds, opacity, hideFromCapture, clickThrough, aboveFullscreen } = getState()

  const opts: Electron.BrowserWindowConstructorOptions = {
    ...clampToDisplay(overlayBounds),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    focusable: !clickThrough,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  }

  if (process.platform === 'linux' && aboveFullscreen) {
    opts.type = 'notification'
  }

  const win = new BrowserWindow(opts)

  win.setAlwaysOnTop(true, 'screen-saver', 1)
  win.setVisibleOnAllWorkspaces(true)
  win.setOpacity(opacity)
  win.setContentProtection(hideFromCapture)
  win.setIgnoreMouseEvents(clickThrough, { forward: true })

  hardenWebContents(win)

  win.on('moved', () => persistBounds('overlayBounds', win))
  win.on('resized', () => persistBounds('overlayBounds', win))

  loadRoute(win, 'overlay')
  windows.overlay = win
  win.on('closed', () => {
    windows.overlay = undefined
    stopCursorPoll()
    stopTopReassertPoll()
  })
  return win
}

export function createControls(): BrowserWindow {
  const { controlsBounds } = getState()

  const win = new BrowserWindow({
    ...clampToDisplay(controlsBounds),
    title: 'Teleprompt — Controls',
    minWidth: 720,
    minHeight: 360,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  hardenWebContents(win)

  win.on('moved', () => persistBounds('controlsBounds', win))
  win.on('resized', () => persistBounds('controlsBounds', win))

  loadRoute(win, 'controls')
  windows.controls = win
  win.on('closed', () => {
    windows.controls = undefined
  })
  return win
}

function hardenWebContents(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = RENDERER_DEV ?? 'file://'
    if (!url.startsWith(allowed)) event.preventDefault()
  })
}

function loadRoute(win: BrowserWindow, route: 'overlay' | 'controls') {
  if (RENDERER_DEV) {
    win.loadURL(`${RENDERER_DEV}/${route}.html`)
    if (route === 'controls' && process.env.OPEN_DEVTOOLS === '1') {
      win.webContents.openDevTools({ mode: 'detach' })
    }
  } else {
    win.loadFile(join(RENDERER_DIST, `${route}.html`))
  }
}

function persistBounds(key: 'overlayBounds' | 'controlsBounds', win: BrowserWindow) {
  setState({ [key]: win.getBounds() } as Partial<import('../shared/types.js').AppState>)
}

function clampToDisplay(bounds: { x: number; y: number; width: number; height: number }) {
  const display = screen.getDisplayMatching(bounds)
  const { x, y, width, height } = display.workArea
  return {
    x: Math.max(x, Math.min(bounds.x, x + width - 200)),
    y: Math.max(y, Math.min(bounds.y, y + height - 100)),
    width: Math.min(bounds.width, width),
    height: Math.min(bounds.height, height),
  }
}

export function broadcastState(state: import('../shared/types.js').AppState) {
  for (const win of [windows.overlay, windows.controls]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('state:update', state)
    }
  }
}

const DRAG_STRIP_HEIGHT = 28
const CURSOR_POLL_MS = 50
const TOP_REASSERT_MS = 500
let cursorPollTimer: ReturnType<typeof setInterval> | null = null
let topReassertTimer: ReturnType<typeof setInterval> | null = null

function startCursorPoll() {
  if (cursorPollTimer) return
  cursorPollTimer = setInterval(() => {
    const win = windows.overlay
    if (!win || win.isDestroyed() || !win.isVisible()) return
    const pos = screen.getCursorScreenPoint()
    const b = win.getBounds()
    const inDragZone =
      pos.x >= b.x &&
      pos.x <= b.x + b.width &&
      pos.y >= b.y &&
      pos.y <= b.y + DRAG_STRIP_HEIGHT
    win.setIgnoreMouseEvents(!inDragZone, { forward: true })
  }, CURSOR_POLL_MS)
}

export function stopCursorPoll() {
  if (cursorPollTimer) {
    clearInterval(cursorPollTimer)
    cursorPollTimer = null
  }
}

function startTopReassertPoll() {
  if (topReassertTimer) return
  topReassertTimer = setInterval(() => {
    const win = windows.overlay
    if (!win || win.isDestroyed() || !win.isVisible()) return
    try {
      win.setAlwaysOnTop(true, 'screen-saver', 1)
      win.moveTop()
    } catch {
      /* swallow */
    }
  }, TOP_REASSERT_MS)
}

export function stopTopReassertPoll() {
  if (topReassertTimer) {
    clearInterval(topReassertTimer)
    topReassertTimer = null
  }
}

export function recreateOverlay(): BrowserWindow {
  const existing = windows.overlay
  if (existing && !existing.isDestroyed()) {
    existing.removeAllListeners('closed')
    existing.close()
  }
  windows.overlay = undefined
  stopCursorPoll()
  return createOverlay()
}

export function applyOverlayEffects() {
  const win = windows.overlay
  if (!win || win.isDestroyed()) {
    stopCursorPoll()
    stopTopReassertPoll()
    return
  }
  const { opacity, hideFromCapture, clickThrough, aboveFullscreen } = getState()
  win.setOpacity(opacity)
  win.setContentProtection(hideFromCapture)
  if (clickThrough) {
    win.setIgnoreMouseEvents(true, { forward: true })
    startCursorPoll()
  } else {
    stopCursorPoll()
    win.setIgnoreMouseEvents(false)
  }
  if (aboveFullscreen) {
    startTopReassertPoll()
  } else {
    stopTopReassertPoll()
  }
}
