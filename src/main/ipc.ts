import { app, dialog, ipcMain } from 'electron'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'

const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB
import type { AppState, BannerPosition, HotkeyCommand, ScriptFile } from '../shared/types.js'
import { DEFAULT_HOTKEYS } from '../shared/types.js'
import { getHotkeyStatus, rebindHotkeys, syncClickerHotkeys } from './hotkeys.js'
import { applyPacingTarget, setLastGeom } from './pacing.js'
import {
  exportPersisted,
  getState,
  getStorePath,
  importPersisted,
  pushRecent,
  resetState,
  setState,
} from './store.js'
import {
  applyOverlayEffects,
  broadcastState,
  createControls,
  getWindows,
  recreateOverlay,
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

const sessionAllowedPaths = new Set<string>()

const PATCHABLE_KEYS: ReadonlyArray<keyof AppState> = [
  'scrollSpeed',
  'opacity',
  'bgDim',
  'fontSize',
  'fontFamily',
  'fontColor',
  'textShadow',
  'mirrorH',
  'mirrorV',
  'eyeLinePosition',
  'showEyeLine',
  'focusMode',
  'clickThrough',
  'hideFromCapture',
  'voicePacing',
  'markdown',
  'bannerMode',
  'bannerPosition',
  'editMode',
  'clickerMode',
  'clickerStep',
  'showChronometer',
  'voiceConsent',
  'countdownEnabled',
  'countdownSeconds',
  'showCueHud',
  'drivePresentation',
  'aboveFullscreen',
  'targetMode',
  'targetDurationSec',
  'targetWpm',
  'hotkeyBindings',
  'playing',
  'scrollPosition',
  'currentFileIndex',
]

function sanitizePatch(raw: unknown): Partial<AppState> {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const out: Partial<AppState> = {}
  for (const key of PATCHABLE_KEYS) {
    if (!(key in r)) continue
    const v = r[key]
    switch (key) {
      case 'fontFamily':
      case 'fontColor':
        if (typeof v === 'string' && v.length < 200) out[key] = v
        break
      case 'bannerPosition':
        if (v === 'top' || v === 'bottom') out.bannerPosition = v as BannerPosition
        break
      case 'scrollSpeed':
        if (typeof v === 'number' && Number.isFinite(v))
          out.scrollSpeed = Math.max(1, Math.min(2000, v))
        break
      case 'fontSize':
        if (typeof v === 'number' && Number.isFinite(v))
          out.fontSize = Math.max(8, Math.min(400, v))
        break
      case 'countdownSeconds':
        if (typeof v === 'number' && Number.isFinite(v))
          out.countdownSeconds = Math.max(0, Math.min(10, Math.floor(v)))
        break
      case 'targetMode':
        if (v === 'duration' || v === 'wpm' || v === null) out.targetMode = v
        break
      case 'targetDurationSec':
        if (v === null) out.targetDurationSec = null
        else if (typeof v === 'number' && Number.isFinite(v) && v > 0)
          out.targetDurationSec = Math.min(36000, v)
        break
      case 'targetWpm':
        if (v === null) out.targetWpm = null
        else if (typeof v === 'number' && Number.isFinite(v) && v > 0)
          out.targetWpm = Math.min(2000, v)
        break
      case 'hotkeyBindings': {
        if (!v || typeof v !== 'object') break
        const m = v as Record<string, unknown>
        const sanitized: Record<HotkeyCommand, string> = { ...DEFAULT_HOTKEYS }
        for (const cmd of Object.keys(DEFAULT_HOTKEYS) as HotkeyCommand[]) {
          const value = m[cmd]
          if (typeof value === 'string' && value.length > 0 && value.length < 80) {
            sanitized[cmd] = value
          }
        }
        out.hotkeyBindings = sanitized
        break
      }
      case 'opacity':
      case 'bgDim':
      case 'eyeLinePosition':
      case 'scrollPosition':
      case 'clickerStep':
        if (typeof v === 'number' && Number.isFinite(v))
          out[key] = Math.max(0, Math.min(1, v)) as never
        break
      case 'currentFileIndex': {
        if (typeof v !== 'number' || !Number.isFinite(v)) break
        const len = getState().files.length
        out.currentFileIndex = Math.max(0, Math.min(Math.floor(v), Math.max(0, len - 1)))
        break
      }
      default:
        if (typeof v === 'boolean') out[key] = v as never
    }
  }
  return out
}

function isAllowedPath(path: string): boolean {
  if (typeof path !== 'string' || !path) return false
  if (sessionAllowedPaths.has(path)) return true
  if (getState().recentFiles.includes(path)) return true
  return ALLOWED_EXTS.has(extname(path).toLowerCase())
}

export function registerIpc() {
  ipcMain.handle('state:get', () => getState())
  ipcMain.handle('hotkeys:status', () => getHotkeyStatus())
  ipcMain.handle('presentation:status', async () => {
    const { presentationCapability } = await import('./presentation.js')
    return presentationCapability()
  })

  ipcMain.handle('platform:info', () => ({
    platform: process.platform,
    displayServer:
      process.platform === 'linux'
        ? (process.env.XDG_SESSION_TYPE ?? 'unknown')
        : process.platform,
    contentProtectionSupported: process.platform !== 'linux',
  }))

  ipcMain.handle('state:patch', (_e, patch: unknown) => {
    const before = getState()
    const clean = sanitizePatch(patch)
    setState(clean)
    applyPacingTarget()
    applyOverlayEffects()
    const after = getState()
    if ('clickerMode' in clean) syncClickerHotkeys(after.clickerMode)
    if ('hotkeyBindings' in clean) rebindHotkeys()
    if ('aboveFullscreen' in clean && clean.aboveFullscreen !== before.aboveFullscreen) {
      recreateOverlay()
    }
    broadcastState(after)
    return after
  })

  ipcMain.handle('files:open', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open script files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Text & docs',
          extensions: [
            'txt',
            'md',
            'markdown',
            'rtf',
            'docx',
            'odt',
            'pdf',
            'html',
            'htm',
            'fountain',
            'srt',
            'vtt',
          ],
        },
        { name: 'All', extensions: ['*'] },
      ],
    })
    if (result.canceled) return { loaded: [], errors: [] }
    const loaded: ScriptFile[] = []
    const errors: { path: string; error: string }[] = []
    for (const path of result.filePaths) {
      sessionAllowedPaths.add(path)
      const r = await loadFileSafe(path)
      if (r.ok) loaded.push(r.file)
      else errors.push({ path: r.path, error: r.error })
    }
    if (loaded.length) {
      const state = getState()
      const next = setState({ files: [...state.files, ...loaded] })
      broadcastState(next)
    }
    return { loaded, errors }
  })

  ipcMain.handle('files:loadPath', async (_e, path: unknown) => {
    if (typeof path !== 'string' || !isAllowedPath(path))
      return { ok: false, error: 'path not allowed' }
    const r = await loadFileSafe(path)
    if (!r.ok) return { ok: false, error: r.error }
    const state = getState()
    const next = setState({ files: [...state.files, r.file] })
    broadcastState(next)
    return { ok: true, file: r.file }
  })

  ipcMain.handle('files:remove', (_e, index: unknown) => {
    if (typeof index !== 'number' || !Number.isFinite(index)) return
    const state = getState()
    const i = Math.floor(index)
    if (i < 0 || i >= state.files.length) return
    const files = state.files.filter((_, j) => j !== i)
    const currentFileIndex = Math.min(state.currentFileIndex, Math.max(0, files.length - 1))
    const next = setState({ files, currentFileIndex, scrollPosition: 0, playing: false })
    broadcastState(next)
  })

  ipcMain.handle('files:select', (_e, index: unknown) => {
    if (typeof index !== 'number' || !Number.isFinite(index)) return
    const state = getState()
    const i = Math.max(0, Math.min(Math.floor(index), Math.max(0, state.files.length - 1)))
    const next = setState({ currentFileIndex: i, scrollPosition: 0, playing: false })
    broadcastState(next)
  })

  ipcMain.handle('files:reload', async () => {
    const state = getState()
    const cur = state.files[state.currentFileIndex]
    if (!cur) return
    if (cur.path.startsWith('mem://')) return
    const reloaded = await loadFile(cur.path)
    if (!reloaded) return
    const files = state.files.map((f, i) => (i === state.currentFileIndex ? reloaded : f))
    const next = setState({ files })
    broadcastState(next)
  })

  ipcMain.handle('playback:toggle', () => {
    const state = getState()
    const next = setState({ playing: !state.playing })
    broadcastState(next)
  })

  ipcMain.handle('scroll:set', (_e, position: unknown) => {
    if (typeof position !== 'number' || !Number.isFinite(position)) return
    const next = setState({ scrollPosition: Math.max(0, Math.min(1, position)) })
    broadcastState(next)
  })

  ipcMain.handle(
    'files:loadContent',
    async (_e, name: unknown, content: unknown, path: unknown) => {
      if (typeof name !== 'string' || typeof content !== 'string') return null
      const safeName = name.slice(0, 200)
      let safePath: string
      if (typeof path === 'string' && isAllowedPath(path)) {
        safePath = path
        sessionAllowedPaths.add(path)
        pushRecent(path)
      } else {
        safePath = `mem://${safeName}-${Date.now()}`
      }
      const file: ScriptFile = { path: safePath, name: safeName, content }
      const state = getState()
      const next = setState({ files: [...state.files, file] })
      broadcastState(next)
      return file
    },
  )

  ipcMain.handle('files:updateContent', (_e, index: unknown, content: unknown) => {
    if (typeof index !== 'number' || typeof content !== 'string') return
    const state = getState()
    const i = Math.floor(index)
    if (i < 0 || i >= state.files.length) return
    const files = state.files.map((f, j) => (j === i ? { ...f, content } : f))
    const next = setState({ files })
    broadcastState(next)
  })

  let dragSession: {
    startScreenX: number
    startScreenY: number
    startWinX: number
    startWinY: number
  } | null = null

  let resizeSession: {
    startScreenX: number
    startScreenY: number
    startW: number
    startH: number
    startX: number
    startY: number
    edge: string
  } | null = null

  ipcMain.handle('drag:start', (_e, sx: unknown, sy: unknown) => {
    if (typeof sx !== 'number' || typeof sy !== 'number') return
    const win = getWindows().overlay
    if (!win || win.isDestroyed()) return
    const b = win.getBounds()
    dragSession = { startScreenX: sx, startScreenY: sy, startWinX: b.x, startWinY: b.y }
  })

  ipcMain.handle('drag:update', (_e, sx: unknown, sy: unknown) => {
    if (!dragSession || typeof sx !== 'number' || typeof sy !== 'number') return
    const win = getWindows().overlay
    if (!win || win.isDestroyed()) return
    win.setPosition(
      Math.round(dragSession.startWinX + (sx - dragSession.startScreenX)),
      Math.round(dragSession.startWinY + (sy - dragSession.startScreenY)),
    )
  })

  ipcMain.handle('drag:end', () => {
    dragSession = null
  })

  ipcMain.handle('resize:start', (_e, sx: unknown, sy: unknown, edge: unknown) => {
    if (typeof sx !== 'number' || typeof sy !== 'number' || typeof edge !== 'string') return
    const win = getWindows().overlay
    if (!win || win.isDestroyed()) return
    const b = win.getBounds()
    resizeSession = {
      startScreenX: sx,
      startScreenY: sy,
      startW: b.width,
      startH: b.height,
      startX: b.x,
      startY: b.y,
      edge,
    }
  })

  ipcMain.handle('resize:update', (_e, sx: unknown, sy: unknown) => {
    if (!resizeSession || typeof sx !== 'number' || typeof sy !== 'number') return
    const win = getWindows().overlay
    if (!win || win.isDestroyed()) return
    const dx = sx - resizeSession.startScreenX
    const dy = sy - resizeSession.startScreenY
    let { startX, startY, startW, startH, edge } = resizeSession
    let newX = startX
    let newY = startY
    let newW = startW
    let newH = startH
    if (edge.includes('e')) newW = startW + dx
    if (edge.includes('s')) newH = startH + dy
    if (edge.includes('w')) {
      newX = startX + dx
      newW = startW - dx
    }
    if (edge.includes('n')) {
      newY = startY + dy
      newH = startH - dy
    }
    newW = Math.max(200, Math.min(8000, newW))
    newH = Math.max(80, Math.min(8000, newH))
    win.setBounds({ x: Math.round(newX), y: Math.round(newY), width: Math.round(newW), height: Math.round(newH) })
  })

  ipcMain.handle('resize:end', () => {
    resizeSession = null
  })

  ipcMain.handle('overlay:reportGeom', (_e, geom: unknown) => {
    if (!geom || typeof geom !== 'object') return
    const g = geom as { textH?: unknown; viewportH?: unknown }
    if (typeof g.textH !== 'number' || typeof g.viewportH !== 'number') return
    const payload = {
      textH: Math.max(0, Math.floor(g.textH)),
      viewportH: Math.max(0, Math.floor(g.viewportH)),
    }
    setLastGeom(payload)
    const { controls } = getWindows()
    if (controls && !controls.isDestroyed()) {
      controls.webContents.send('overlay:geom', payload)
    }
    if (applyPacingTarget()) broadcastState(getState())
  })

  ipcMain.handle('controls:focus', () => {
    let { controls } = getWindows()
    if (!controls || controls.isDestroyed()) {
      controls = createControls()
    }
    if (controls.isMinimized()) controls.restore()
    controls.show()
    controls.focus()
  })

  ipcMain.handle('controls:toggle', () => {
    let { controls } = getWindows()
    if (!controls || controls.isDestroyed()) {
      controls = createControls()
      controls.show()
      controls.focus()
      return
    }
    if (controls.isVisible() && !controls.isMinimized()) {
      controls.hide()
    } else {
      if (controls.isMinimized()) controls.restore()
      controls.show()
      controls.focus()
    }
  })

  ipcMain.handle('settings:reset', () => {
    const next = resetState()
    rebindHotkeys()
    applyOverlayEffects()
    broadcastState(next)
    return next
  })

  ipcMain.handle('settings:export', async () => {
    const persisted = exportPersisted()
    const result = await dialog.showSaveDialog({
      title: 'Export Teleprompt config',
      defaultPath: 'teleprompt-config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' }
    try {
      await writeFile(result.filePath, JSON.stringify(persisted, null, 2), 'utf8')
      return { ok: true, path: result.filePath }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'write failed' }
    }
  })

  ipcMain.handle('settings:import', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import Teleprompt config',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePaths[0]) return { ok: false, error: 'cancelled' }
    try {
      const raw = await readFile(result.filePaths[0], 'utf8')
      const parsed = JSON.parse(raw)
      const next = importPersisted(parsed)
      rebindHotkeys()
      applyOverlayEffects()
      broadcastState(next)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'import failed' }
    }
  })

  ipcMain.handle('settings:about', () => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    storePath: getStorePath(),
  }))

  ipcMain.handle('files:save', async () => {
    const state = getState()
    const cur = state.files[state.currentFileIndex]
    if (!cur) return { ok: false, error: 'no current file' }

    const isMem = cur.path.startsWith('mem://')
    const inSession = sessionAllowedPaths.has(cur.path)
    const needsDialog = isMem || !inSession

    let targetPath = cur.path
    if (needsDialog) {
      const result = await dialog.showSaveDialog({
        title: 'Save script',
        defaultPath: isMem ? cur.name : cur.path,
        filters: [
          { name: 'Text', extensions: ['txt', 'md'] },
          { name: 'All', extensions: ['*'] },
        ],
      })
      if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' }
      targetPath = result.filePath
      sessionAllowedPaths.add(targetPath)
    }

    try {
      await writeFile(targetPath, cur.content, 'utf8')
      if (targetPath !== cur.path) {
        const renamed: ScriptFile = {
          path: targetPath,
          name: basename(targetPath),
          content: cur.content,
        }
        const files = state.files.map((f, i) => (i === state.currentFileIndex ? renamed : f))
        pushRecent(targetPath)
        const next = setState({ files })
        broadcastState(next)
      }
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'write failed'
      return { ok: false, error: msg }
    }
  })
}

type LoadResult =
  | { ok: true; file: ScriptFile }
  | { ok: false; error: string; path: string }

async function loadFile(path: string): Promise<ScriptFile | null> {
  const r = await loadFileSafe(path)
  return r.ok ? r.file : null
}

async function loadFileSafe(path: string): Promise<LoadResult> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return { ok: false, error: 'not a regular file', path }
    if (info.size > MAX_FILE_BYTES)
      return { ok: false, error: `file too large (>${MAX_FILE_BYTES / 1024 / 1024} MB)`, path }
    const ext = extname(path).toLowerCase()
    let content: string
    if (ext === '.docx') {
      const mammoth = await import('mammoth')
      const buf = await readFile(path)
      const result = await mammoth.extractRawText({ buffer: buf })
      content = result.value
    } else if (ext === '.rtf') {
      const { rtfToText } = await import('./rtf.js')
      const buf = await readFile(path)
      content = rtfToText(buf.toString('utf8'))
    } else if (ext === '.pdf') {
      try {
        const { PDFParse } = await import('pdf-parse')
        const buf = await readFile(path)
        const parser = new PDFParse({ data: new Uint8Array(buf) })
        const result = await parser.getText()
        content = (result.text ?? '').trim()
        if (!content) {
          return {
            ok: false,
            error: 'No extractable text — PDF appears to be scanned/image-only',
            path,
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'PDF parse failed'
        console.error('[pdf]', path, msg)
        return { ok: false, error: `PDF parse failed: ${msg}`, path }
      }
    } else if (ext === '.html' || ext === '.htm') {
      const { stripHtmlTags } = await import('./html.js')
      const buf = await readFile(path)
      content = stripHtmlTags(buf.toString('utf8'))
    } else if (ext === '.odt') {
      const { odtToText } = await import('./odt.js')
      const buf = await readFile(path)
      content = await odtToText(buf)
    } else if (ext === '.srt') {
      const { srtToText } = await import('./subtitles.js')
      const buf = await readFile(path)
      content = srtToText(buf.toString('utf8'))
    } else if (ext === '.vtt') {
      const { vttToText } = await import('./subtitles.js')
      const buf = await readFile(path)
      content = vttToText(buf.toString('utf8'))
    } else {
      const buf = await readFile(path)
      if (containsNullByte(buf))
        return { ok: false, error: 'binary file (NUL byte detected)', path }
      content = buf.toString('utf8')
    }
    pushRecent(path)
    sessionAllowedPaths.add(path)
    return { ok: true, file: { path, name: basename(path), content } }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'read failed', path }
  }
}

function containsNullByte(buf: Buffer): boolean {
  const cap = Math.min(buf.length, 64 * 1024)
  for (let i = 0; i < cap; i++) if (buf[i] === 0) return true
  return false
}

export function allowSessionPath(path: string): void {
  sessionAllowedPaths.add(path)
}

export async function loadPathOnStartup(path: string): Promise<boolean> {
  sessionAllowedPaths.add(path)
  const r = await loadFileSafe(path)
  if (!r.ok) {
    console.error('[startup-load]', path, r.error)
    return false
  }
  const state = getState()
  setState({ files: [...state.files, r.file] })
  applyPacingTarget()
  broadcastState(getState())
  return true
}
