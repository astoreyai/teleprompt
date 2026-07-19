import { BrowserWindow, dialog, screen, type WebContents } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppSnapshot, DocumentContent } from '../shared/contracts.js'
import type { RendererRole } from '../shared/ipc.js'
import type { Bounds } from '../shared/types.js'
import { RendererRecoveryPolicy, type RendererExitReason } from './lifecycle/recovery-policy.js'
import { logCrash } from './log.js'
import { projectOverlaySnapshot } from './platform/overlay-projection.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PRELOAD = join(__dirname, '../preload/index.js')
const RENDERER_DEV = process.env.ELECTRON_RENDERER_URL

export type Windows = { overlay?: BrowserWindow; controls?: BrowserWindow }

type WindowRuntime = {
  getSnapshot(): AppSnapshot
  updateBounds(key: 'overlayBounds' | 'controlsBounds', bounds: Bounds): void
  onRendererGone(role: RendererRole, reason: string): void
  onOverlayVisibilityChanged(visible: boolean): void
  isQuitting(): boolean
}

let runtime: WindowRuntime | null = null
const windows: Windows = {}
const recoveryDisposers = new WeakMap<BrowserWindow, () => void>()
const recreatingWindows = new WeakSet<BrowserWindow>()
const renderProcessGoneWindows = new WeakSet<BrowserWindow>()

export function configureWindowRuntime(next: WindowRuntime): void {
  runtime = next
}

function getRuntime(): WindowRuntime {
  if (!runtime) throw new Error('window runtime has not been configured')
  return runtime
}

export function getWindows(): Windows {
  return windows
}

export function getRendererRole(contents: WebContents): RendererRole | null {
  if (windows.controls?.webContents.id === contents.id) return 'controls'
  if (windows.overlay?.webContents.id === contents.id) return 'overlay'
  return null
}

export function getRendererUrl(role: RendererRole): string | null {
  return RENDERER_DEV
    ? new URL(`${role}.html`, ensureTrailingSlash(RENDERER_DEV)).toString()
    : `teleprompt://app/${role}.html`
}

export function createOverlay(): BrowserWindow {
  const existing = windows.overlay
  if (existing && !existing.isDestroyed()) return existing
  const snapshot = getRuntime().getSnapshot()
  const opts: Electron.BrowserWindowConstructorOptions = {
    ...clampToDisplay(snapshot.overlayBounds, 'overlay'),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    focusable: !snapshot.clickThrough,
    show: snapshot.overlayVisible,
    webPreferences: secureWebPreferences('overlay'),
  }
  if (process.platform === 'linux' && snapshot.aboveFullscreen) opts.type = 'notification'

  const win = new BrowserWindow(opts)
  windows.overlay = win
  win.setAlwaysOnTop(true, 'screen-saver', 1)
  win.setVisibleOnAllWorkspaces(true)
  hardenWebContents(win)
  recoveryDisposers.set(win, attachCrashRecovery(win, 'overlay'))
  win.on('moved', () => persistBounds('overlayBounds', win))
  win.on('resized', () => persistBounds('overlayBounds', win))
  win.on('closed', () => {
    recoveryDisposers.get(win)?.()
    recoveryDisposers.delete(win)
    if (windows.overlay === win) windows.overlay = undefined
    stopCursorPoll()
    stopTopReassertPoll()
    if (!getRuntime().isQuitting() && !recreatingWindows.has(win)) {
      getRuntime().onOverlayVisibilityChanged(false)
    }
  })
  void loadRouteWithRetry(win, 'overlay')
  applyOverlayEffects()
  return win
}

export function createControls(): BrowserWindow {
  const existing = windows.controls
  if (existing && !existing.isDestroyed()) return existing
  const snapshot = getRuntime().getSnapshot()
  const win = new BrowserWindow({
    ...clampToDisplay(snapshot.controlsBounds, 'controls'),
    title: 'Teleprompt — Controls',
    minWidth: 560,
    minHeight: 360,
    webPreferences: secureWebPreferences('controls'),
  })
  windows.controls = win
  hardenWebContents(win)
  recoveryDisposers.set(win, attachCrashRecovery(win, 'controls'))
  win.on('moved', () => persistBounds('controlsBounds', win))
  win.on('resized', () => persistBounds('controlsBounds', win))
  win.on('closed', () => {
    recoveryDisposers.get(win)?.()
    recoveryDisposers.delete(win)
    if (windows.controls === win) windows.controls = undefined
  })
  void loadRouteWithRetry(win, 'controls')
  return win
}

function secureWebPreferences(role: RendererRole): Electron.WebPreferences {
  return {
    preload: PRELOAD,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    spellcheck: role === 'controls',
    additionalArguments: [`--teleprompt-surface=${role}`],
  }
}

function hardenWebContents(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())
}

function attachCrashRecovery(win: BrowserWindow, role: RendererRole): () => void {
  const policy = new RendererRecoveryPolicy()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let unresponsiveTimer: ReturnType<typeof setTimeout> | null = null
  const onGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
    renderProcessGoneWindows.add(win)
    logCrash(`render-process-gone[${role}] reason=${details.reason} exitCode=${details.exitCode}`)
    getRuntime().onRendererGone(role, details.reason)
    const decision = policy.decide({
      reason: details.reason,
      now: Date.now(),
      appQuitting: getRuntime().isQuitting(),
    })
    if (decision.action === 'none') return
    if (decision.action === 'give-up') {
      logCrash(`renderer recovery budget exhausted[${role}]`)
      dialog.showErrorBox(
        'Teleprompt renderer failed',
        `The ${role} window repeatedly failed and was stopped. Restart Teleprompt; recovery drafts are preserved.`,
      )
      return
    }
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (getRuntime().isQuitting()) return
      if (decision.action === 'recreate') {
        role === 'overlay' ? recreateOverlay() : recreateControls()
      } else if (!win.isDestroyed()) {
        renderProcessGoneWindows.delete(win)
        void loadRouteWithRetry(win, role)
      }
    }, decision.delayMs)
    timers.add(timer)
  }
  const onUnresponsive = () => {
    logCrash(`unresponsive[${role}]`)
    getRuntime().onRendererGone(role, 'unresponsive')
    if (unresponsiveTimer) return
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null
      if (getRuntime().isQuitting() || win.isDestroyed()) return
      role === 'overlay' ? recreateOverlay() : recreateControls()
    }, 5_000)
  }
  const onResponsive = () => {
    logCrash(`responsive[${role}]`)
    if (unresponsiveTimer) clearTimeout(unresponsiveTimer)
    unresponsiveTimer = null
  }
  const onLoadFailure = (
    _event: Electron.Event,
    code: number,
    description: string,
    url: string,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame && code !== -3) logCrash(`did-fail-load[${role}] ${code} ${description} ${url}`)
  }
  win.webContents.on('render-process-gone', onGone)
  win.webContents.on('unresponsive', onUnresponsive)
  win.webContents.on('responsive', onResponsive)
  win.webContents.on('did-fail-load', onLoadFailure)
  return () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    if (unresponsiveTimer) clearTimeout(unresponsiveTimer)
    if (!win.webContents.isDestroyed()) {
      win.webContents.off('render-process-gone', onGone)
      win.webContents.off('unresponsive', onUnresponsive)
      win.webContents.off('responsive', onResponsive)
      win.webContents.off('did-fail-load', onLoadFailure)
    }
  }
}

async function loadRoute(win: BrowserWindow, role: RendererRole): Promise<void> {
  if (RENDERER_DEV) {
    await win.loadURL(getRendererUrl(role)!)
    if (role === 'controls' && process.env.OPEN_DEVTOOLS === '1') {
      win.webContents.openDevTools({ mode: 'detach' })
    }
  } else {
    await win.loadURL(`teleprompt://app/${role}.html`)
  }
}

async function loadRouteWithRetry(win: BrowserWindow, role: RendererRole): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await loadRoute(win, role)
      return
    } catch (error) {
      logCrash(`renderer load failed[${role}] attempt=${attempt}: ${formatError(error)}`)
      if (
        getRuntime().isQuitting() ||
        win.isDestroyed() ||
        windows[role] !== win ||
        renderProcessGoneWindows.has(win)
      ) return
      if (attempt < 3) await wait(250 * 2 ** (attempt - 1))
    }
  }
  if (!getRuntime().isQuitting() && !win.isDestroyed() && windows[role] === win) {
    dialog.showErrorBox(
      'Teleprompt window failed to load',
      `The ${role} surface could not be loaded after three attempts. Restart Teleprompt; recovery drafts are preserved.`,
    )
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

function persistBounds(key: 'overlayBounds' | 'controlsBounds', win: BrowserWindow): void {
  if (!win.isDestroyed()) getRuntime().updateBounds(key, win.getBounds())
}

function clampToDisplay(bounds: Bounds, role: RendererRole): Bounds {
  const display = screen.getDisplayMatching(bounds)
  const work = display.workArea
  const minWidth = role === 'controls' ? Math.min(560, work.width) : Math.min(200, work.width)
  const minHeight = role === 'controls' ? Math.min(360, work.height) : Math.min(80, work.height)
  const width = Math.max(minWidth, Math.min(bounds.width, work.width))
  const height = Math.max(minHeight, Math.min(bounds.height, work.height))
  return {
    x: Math.max(work.x, Math.min(bounds.x, work.x + work.width - width)),
    y: Math.max(work.y, Math.min(bounds.y, work.y + work.height - height)),
    width,
    height,
  }
}

export function broadcastSnapshot(snapshot: AppSnapshot): void {
  sendToWindow(windows.controls, 'snapshot:changed', snapshot)
  sendToWindow(windows.overlay, 'snapshot:changed', projectOverlaySnapshot(snapshot))
}

export function broadcastActiveDocument(document: DocumentContent | null): void {
  sendToAll('document:changed', document)
}

export function sendProgress(position: number): void {
  sendToWindow(windows.controls, 'playback:progress', position)
}

export function sendOverlayGeometry(geometry: { textH: number; viewportH: number }): void {
  sendToWindow(windows.controls, 'overlay:geometry', geometry)
}

function sendToAll(channel: string, payload: unknown): void {
  sendToWindow(windows.overlay, channel, payload)
  sendToWindow(windows.controls, channel, payload)
}

function sendToWindow(win: BrowserWindow | undefined, channel: string, payload: unknown): void {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload)
}

export function recreateOverlay(): BrowserWindow {
  destroyForRecreation('overlay')
  stopCursorPoll()
  stopTopReassertPoll()
  return createOverlay()
}

export function recreateControls(): BrowserWindow {
  destroyForRecreation('controls')
  return createControls()
}

function destroyForRecreation(role: RendererRole): void {
  const existing = windows[role]
  if (!existing || existing.isDestroyed()) return
  recoveryDisposers.get(existing)?.()
  recoveryDisposers.delete(existing)
  recreatingWindows.add(existing)
  existing.destroy()
  windows[role] = undefined
}

export function focusControls(): void {
  const win = createControls()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export function setOverlayVisible(visible: boolean): void {
  if (visible) createOverlay().show()
  else windows.overlay?.hide()
}

export function applyOverlayEffects(): void {
  const win = windows.overlay
  if (!win || win.isDestroyed()) {
    stopCursorPoll()
    stopTopReassertPoll()
    return
  }
  const snapshot = getRuntime().getSnapshot()
  win.setOpacity(snapshot.opacity)
  win.setContentProtection(snapshot.hideFromCapture)
  if (snapshot.overlayVisible) win.show()
  else win.hide()
  if (snapshot.clickThrough) {
    win.setIgnoreMouseEvents(true, { forward: true })
    startCursorPoll()
  } else {
    stopCursorPoll()
    win.setIgnoreMouseEvents(false)
  }
  if (snapshot.aboveFullscreen) startTopReassertPoll()
  else stopTopReassertPoll()
}

const DRAG_STRIP_HEIGHT = 28
const CURSOR_POLL_MS = 50
const TOP_REASSERT_MS = 500
let cursorPollTimer: ReturnType<typeof setInterval> | null = null
let topReassertTimer: ReturnType<typeof setInterval> | null = null

function startCursorPoll(): void {
  if (cursorPollTimer) return
  cursorPollTimer = setInterval(() => {
    const win = windows.overlay
    if (!win || win.isDestroyed() || !win.isVisible()) return
    const pos = screen.getCursorScreenPoint()
    const bounds = win.getBounds()
    const inDragZone =
      pos.x >= bounds.x &&
      pos.x <= bounds.x + bounds.width &&
      pos.y >= bounds.y &&
      pos.y <= bounds.y + DRAG_STRIP_HEIGHT
    win.setIgnoreMouseEvents(!inDragZone, { forward: true })
  }, CURSOR_POLL_MS)
  cursorPollTimer.unref?.()
}

export function stopCursorPoll(): void {
  if (cursorPollTimer) clearInterval(cursorPollTimer)
  cursorPollTimer = null
}

function startTopReassertPoll(): void {
  if (topReassertTimer) return
  topReassertTimer = setInterval(() => {
    const win = windows.overlay
    if (!win || win.isDestroyed() || !win.isVisible()) return
    try {
      win.setAlwaysOnTop(true, 'screen-saver', 1)
      win.moveTop()
    } catch (error) {
      logCrash(`always-on-top reassert failed: ${formatError(error)}`)
    }
  }, TOP_REASSERT_MS)
  topReassertTimer.unref?.()
}

export function stopTopReassertPoll(): void {
  if (topReassertTimer) clearInterval(topReassertTimer)
  topReassertTimer = null
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
