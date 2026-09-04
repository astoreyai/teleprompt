import { app, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { basename, extname, parse } from 'node:path'
import type { DocumentContent, DocumentId } from '../shared/contracts.js'
import type { OverlayGeometry, PreferencePatch, RendererRole } from '../shared/ipc.js'
import { MAX_DOCUMENT_BYTES } from '../shared/text.js'
import { DEFAULT_HOTKEYS, type HotkeyCommand } from '../shared/types.js'
import type { AppStore } from './application/app-store.js'
import type { AppController } from './application/controller.js'
import { exportablePreferences, sanitizePreferencePatch } from './application/preferences.js'
import type { DocumentImportService } from './documents/import-service.js'
import type { DocumentSaveService } from './documents/save-service.js'
import { saveTextAtomically } from './files/atomic-write.js'
import { supportedExtensions } from './files/file-policy.js'
import { readBoundedRegularFile } from './files/safe-reader.js'
import type { HotkeyManager } from './hotkeys.js'
import type { PacingService } from './pacing.js'
import { presentationCapability } from './presentation.js'
import { authorizeIpc, IPC_POLICY, type IpcChannel } from './platform/ipc-policy.js'
import { projectOverlaySnapshot } from './platform/overlay-projection.js'
import {
  applyOverlayEffects,
  broadcastActiveDocument,
  broadcastSnapshot,
  focusControls,
  getRendererRole,
  getRendererUrl,
  getWindows,
  recreateOverlay,
  sendOverlayGeometry,
  sendProgress,
  sendControlsEvent,
  setOverlayVisible,
} from './windows.js'

export type IpcDependencies = {
  ready: Promise<void>
  store: AppStore
  controller: AppController
  importer: DocumentImportService
  saver: DocumentSaveService
  hotkeys: HotkeyManager
  pacing: PacingService
}

const registeredChannels = new Set<IpcChannel>()
let closingPhase: 'open' | 'flushing' | 'draining' = 'open'
let importGeneration = 0
const inFlight = new Set<Promise<unknown>>()
let pendingEditorFlush: {
  id: string
  senderId: number
  promise: Promise<boolean>
  finish(ok: boolean): void
} | null = null

export function setIpcClosing(phase: 'open' | 'flushing' | 'draining'): void {
  if (phase === 'flushing' && closingPhase === 'open') importGeneration += 1
  closingPhase = phase
  sendControlsEvent('app:closing', phase !== 'open')
}

export function cancelIpcImports(dependencies: IpcDependencies): void {
  importGeneration += 1
  dependencies.importer.cancelPending()
}

export function requestEditorFlush(): Promise<boolean> {
  if (pendingEditorFlush) return pendingEditorFlush.promise
  const controls = getWindows().controls
  if (!controls || controls.isDestroyed()) return Promise.resolve(true)
  const contents = controls.webContents
  if (contents.isDestroyed() || contents.isCrashed()) return Promise.resolve(true)
  if (contents.isLoadingMainFrame()) return Promise.resolve(false)
  let resolveFlush!: (ok: boolean) => void
  const promise = new Promise<boolean>((resolve) => { resolveFlush = resolve })
  const id = randomUUID()
  const finish = (ok: boolean) => {
    if (pendingEditorFlush?.id !== id) return
    clearTimeout(timer)
    contents.removeListener('destroyed', onGone)
    contents.removeListener('render-process-gone', onGone)
    pendingEditorFlush = null
    resolveFlush(ok)
  }
  const onGone = () => finish(false)
  const timer = setTimeout(() => finish(false), 5000)
  pendingEditorFlush = { id, senderId: contents.id, promise, finish }
  contents.once('destroyed', onGone)
  contents.once('render-process-gone', onGone)
  try { contents.send('editor:flush', id) } catch { finish(false) }
  return promise
}

export async function drainIpcCommands(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight])
}

function assertMutationOpen(): void {
  if (closingPhase !== 'open') throw new Error('Teleprompt is closing; this operation was cancelled')
}

export function registerIpc(dependencies: IpcDependencies): void {
  if (registeredChannels.size > 0) throw new Error('IPC is already registered')
  secureHandle('editor:flushed', dependencies, (event, raw) => {
    const request = requireRecord(raw)
    const id = requireString(request.requestId, 'requestId', 128)
    if (pendingEditorFlush?.id === id && pendingEditorFlush.senderId === event.sender.id) {
      pendingEditorFlush.finish(requireBoolean(request.ok))
    }
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
    edge: ResizeEdge
  } | null = null

  secureHandle('app:bootstrap', dependencies, (event) => {
    const snapshot = dependencies.store.getSnapshot()
    const activeDocument = activeContent(dependencies.store)
    if (getRendererRole(event.sender) === 'overlay') {
      return {
        snapshot: projectOverlaySnapshot(snapshot),
        activeDocument,
        hasStartupIssues: dependencies.store.getIssues().length > 0,
      }
    }
    return { snapshot, activeDocument, startupIssues: dependencies.store.getIssues(), unresolvedDocuments: dependencies.store.getUnresolvedDocuments() }
  })

  secureHandle('documents:open', dependencies, async () => {
    const generation = importGeneration
    const result = await dialog.showOpenDialog({
      title: 'Open script files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Scripts and documents', extensions: supportedExtensions() },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled) return { loaded: [], errors: [] }
    assertMutationOpen()
    if (generation !== importGeneration) throw new Error('Document import was cancelled')
    const loaded = []
    const errors: Array<{ name: string; error: string }> = []
    for (const path of result.filePaths) {
      if (closingPhase !== 'open' || generation !== importGeneration) break
      try {
        const imported = await dependencies.importer.loadPath(path)
        assertMutationOpen()
        if (generation !== importGeneration) throw new Error('Document import was cancelled')
        loaded.push(await dependencies.store.addImportedDocument(imported, loaded.length === 0))
      } catch (error) {
        errors.push({ name: basename(path), error: formatError(error) })
        if (closingPhase !== 'open' || generation !== importGeneration) break
      }
    }
    if (loaded.length > 0) publish(dependencies, true)
    return { loaded, errors }
  })

  secureHandle('documents:openRecent', dependencies, async (_event, raw) => {
    const path = requirePath(raw)
    if (!dependencies.store.getSnapshot().recentFiles.includes(path)) {
      return { ok: false, error: 'recent file grant is no longer valid' }
    }
    return importOne(dependencies, path)
  })

  secureHandle('documents:openDropped', dependencies, async (_event, raw) => {
    return importOne(dependencies, requirePath(raw))
  })

  secureHandle('documents:create', dependencies, async (_event, raw) => {
    const request = requireRecord(raw)
    const name = requireString(request.name, 'name', 200)
    const content = requireContent(request.content)
    if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) throw new Error('document exceeds the 10 MiB limit')
    const format = request.format
    if (format !== 'text' && format !== 'markdown' && format !== 'fountain') {
      throw new Error('invalid create format')
    }
    const document = await dependencies.store.createDocument(name, content, format)
    publish(dependencies, true)
    return document
  })

  secureHandle('documents:select', dependencies, (_event, raw) => {
    const id = requireId(raw)
    const ok = dependencies.controller.selectDocument(id)
    if (ok) {
      dependencies.pacing.applyTarget()
      publish(dependencies, true)
    }
    return { ok }
  })

  secureHandle('documents:remove', dependencies, async (_event, raw) => {
    const request = requireRecord(raw)
    const result = await dependencies.store.removeDocument(
      requireId(request.id),
      request.discardDirty === true,
    )
    if (result.ok) publish(dependencies, true)
    return result
  })

  secureHandle('documents:update', dependencies, async (_event, raw) => {
    const request = requireRecord(raw)
    const content = requireContent(request.content)
    if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) {
      return { ok: false, reason: 'too-large' } as const
    }
    const result = await dependencies.store.updateDocument({
      id: requireId(request.id),
      expectedRevision: requireInteger(request.expectedRevision, 0, Number.MAX_SAFE_INTEGER),
      content,
    })
    if (result.ok) publish(dependencies, true)
    return result
  })

  secureHandle('documents:save', dependencies, async (_event, raw) => {
    const request = requireRecord(raw)
    const id = requireId(request.id)
    const forceSaveAs = request.saveAs === true
    const document = dependencies.store.getDocument(id)
    if (!document) return { ok: false, reason: 'not-found' }
    let targetPath: string | undefined
    if (document.saveMode === 'save-as' || forceSaveAs) {
      const stem = parse(document.name).name || 'teleprompt-script'
      const extension = forceSaveAs && document.saveMode === 'overwrite'
        ? (extname(document.name) || '.txt')
        : '.md'
      const result = await dialog.showSaveDialog({
        title: forceSaveAs ? 'Save script copy' : 'Save extracted script as text',
        defaultPath: `${stem}${forceSaveAs ? '-copy' : ''}${extension}`,
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: 'Plain text', extensions: ['txt'] },
          { name: 'Fountain', extensions: ['fountain'] },
        ],
      })
      if (result.canceled || !result.filePath) return { ok: false, reason: 'cancelled' }
      assertMutationOpen()
      targetPath = result.filePath
    }
    const saved = await dependencies.store.saveDocument(id, dependencies.saver, targetPath)
    if (!saved.ok) {
      if (saved.reason === 'storage-failed') {
        publish(dependencies, true)
        return saved
      }
      const reason = saved.reason === 'save-as-required' ? 'invalid-target' : saved.reason
      return { ok: false, reason, ...('error' in saved ? { error: saved.error } : {}) }
    }
    publish(dependencies, true)
    const meta = dependencies.store.getSnapshot().documents.find((item) => item.id === id)
    return meta ? { ok: true, document: meta } : { ok: false, reason: 'not-found' }
  })

  secureHandle('documents:reload', dependencies, async (_event, raw) => {
    const request = requireRecord(raw)
    const result = await dependencies.store.reloadDocument(
      requireId(request.id),
      request.discardDirty === true,
      dependencies.importer,
    )
    if (result.ok) publish(dependencies, true)
    return result
  })

  secureHandle('playback:toggle', dependencies, () => {
    const result = dependencies.controller.togglePlayback()
    broadcastSnapshot(dependencies.store.getSnapshot())
    return result
  })

  secureHandle('playback:restart', dependencies, () => {
    dependencies.controller.restart()
    broadcastSnapshot(dependencies.store.getSnapshot())
  })

  secureHandle('playback:seek', dependencies, (_event, raw) => {
    dependencies.controller.seek(requireNumber(raw, 0, 1))
    broadcastSnapshot(dependencies.store.getSnapshot())
  })

  secureHandle('playback:checkpoint', dependencies, (_event, raw) => {
    const request = requireRecord(raw)
    const result = dependencies.controller.checkpoint({
      documentId: requireId(request.documentId),
      revision: requireInteger(request.revision, 0, Number.MAX_SAFE_INTEGER),
      sessionId: requireString(request.sessionId, 'sessionId', 128),
      seekGeneration: requireInteger(request.seekGeneration, 0, Number.MAX_SAFE_INTEGER),
      position: requireNumber(request.position, 0, 1),
      terminal: request.terminal === true,
    })
    if (result.ok) {
      const position = dependencies.store.getSnapshot().scrollPosition
      sendProgress(position)
      if (request.terminal || position >= 1) broadcastSnapshot(dependencies.store.getSnapshot())
    }
    return result
  })

  secureHandle('preferences:update', dependencies, (_event, raw) => {
    const before = dependencies.store.getSnapshot()
    const patch = sanitizePreferencePatch(raw)
    const after = dependencies.store.patchState(patch)
    dependencies.pacing.applyTarget()
    if (patch.aboveFullscreen !== undefined && patch.aboveFullscreen !== before.aboveFullscreen) {
      recreateOverlay()
    }
    applyOverlayEffects()
    broadcastSnapshot(dependencies.store.getSnapshot())
    return after
  })

  secureHandle('preferences:reset', dependencies, () => {
    const snapshot = dependencies.store.resetPreferences()
    dependencies.hotkeys.register()
    recreateOverlay()
    broadcastSnapshot(snapshot)
    return snapshot
  })

  secureHandle('preferences:clearRecent', dependencies, () => {
    const snapshot = dependencies.store.patchState({ recentFiles: [] })
    broadcastSnapshot(snapshot)
    return snapshot
  })

  secureHandle('preferences:export', dependencies, async () => {
    const result = await dialog.showSaveDialog({
      title: 'Export Teleprompt preferences',
      defaultPath: 'teleprompt-preferences.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    assertMutationOpen()
    if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' }
    try {
      const saved = await saveTextAtomically({
        targetPath: result.filePath,
        content: `${JSON.stringify(exportablePreferences(dependencies.store.getSnapshot()), null, 2)}\n`,
      })
      return saved.ok
        ? { ok: true, path: result.filePath }
        : { ok: false, error: 'error' in saved ? saved.error : saved.reason }
    } catch (error) {
      return { ok: false, error: formatError(error) }
    }
  })

  secureHandle('preferences:import', dependencies, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import Teleprompt preferences',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    assertMutationOpen()
    if (result.canceled || !result.filePaths[0]) return { ok: false, error: 'cancelled' }
    try {
      const file = await readBoundedRegularFile(result.filePaths[0], 1024 * 1024)
      assertMutationOpen()
      const raw = JSON.parse(file.bytes.toString('utf8')) as unknown
      const record = requireRecord(raw)
      if (record.version !== 1) return { ok: false, error: 'unsupported preference version' }
      const patch = sanitizePreferencePatch(record.preferences)
      delete patch.editMode
      dependencies.store.patchState(patch)
      const bindings = sanitizeHotkeys(record.hotkeyBindings)
      if (bindings) dependencies.hotkeys.rebind(bindings)
      applyOverlayEffects()
      broadcastSnapshot(dependencies.store.getSnapshot())
      return { ok: true }
    } catch (error) {
      return { ok: false, error: formatError(error) }
    }
  })

  secureHandle('preferences:about', dependencies, () => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    storePath: dependencies.store.getStorePath(),
  }))

  secureHandle('overlay:setVisible', dependencies, (_event, raw) => {
    const visible = requireBoolean(raw)
    dependencies.store.patchState({ overlayVisible: visible })
    setOverlayVisible(visible)
    broadcastSnapshot(dependencies.store.getSnapshot())
  })

  secureHandle('overlay:reportGeometry', dependencies, (_event, raw) => {
    const geometry = requireGeometry(raw)
    const changed = dependencies.pacing.setGeometry(geometry)
    sendOverlayGeometry(dependencies.pacing.getGeometry())
    if (changed) broadcastSnapshot(dependencies.store.getSnapshot())
  })

  secureHandle('overlay:dragStart', dependencies, (_event, raw) => {
    const [screenX, screenY] = requirePoint(raw)
    const win = getWindows().overlay
    if (!win || win.isDestroyed()) return
    const bounds = win.getBounds()
    dragSession = {
      startScreenX: screenX,
      startScreenY: screenY,
      startWinX: bounds.x,
      startWinY: bounds.y,
    }
  })

  secureHandle('overlay:dragUpdate', dependencies, (_event, raw) => {
    if (!dragSession) return
    const [screenX, screenY] = requirePoint(raw)
    const win = getWindows().overlay
    if (!win || win.isDestroyed()) return
    win.setPosition(
      Math.round(dragSession.startWinX + screenX - dragSession.startScreenX),
      Math.round(dragSession.startWinY + screenY - dragSession.startScreenY),
    )
  })

  secureHandle('overlay:dragEnd', dependencies, () => {
    dragSession = null
  })

  secureHandle('overlay:resizeStart', dependencies, (_event, raw) => {
    const request = requireRecord(raw)
    const [screenX, screenY] = requirePoint(request)
    const edge = requireResizeEdge(request.edge)
    const win = getWindows().overlay
    if (!win || win.isDestroyed()) return
    const bounds = win.getBounds()
    resizeSession = {
      startScreenX: screenX,
      startScreenY: screenY,
      startW: bounds.width,
      startH: bounds.height,
      startX: bounds.x,
      startY: bounds.y,
      edge,
    }
  })

  secureHandle('overlay:resizeUpdate', dependencies, (_event, raw) => {
    if (!resizeSession) return
    const [screenX, screenY] = requirePoint(raw)
    const win = getWindows().overlay
    if (!win || win.isDestroyed()) return
    const dx = screenX - resizeSession.startScreenX
    const dy = screenY - resizeSession.startScreenY
    let x = resizeSession.startX
    let y = resizeSession.startY
    let width = resizeSession.startW
    let height = resizeSession.startH
    if (resizeSession.edge.includes('e')) width += dx
    if (resizeSession.edge.includes('s')) height += dy
    if (resizeSession.edge.includes('w')) {
      x += dx
      width -= dx
    }
    if (resizeSession.edge.includes('n')) {
      y += dy
      height -= dy
    }
    win.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(Math.max(200, Math.min(8000, width))),
      height: Math.round(Math.max(80, Math.min(8000, height))),
    })
  })

  secureHandle('overlay:resizeEnd', dependencies, () => {
    resizeSession = null
  })

  secureHandle('overlay:openEditor', dependencies, () => {
    dependencies.controller.pause()
    dependencies.store.patchState({ editMode: true })
    focusControls()
    broadcastSnapshot(dependencies.store.getSnapshot())
  })

  secureHandle('controls:focus', dependencies, () => focusControls())

  secureHandle('voice:grantConsent', dependencies, async () => {
    dependencies.controller.grantVoiceConsent()
    await dependencies.store.flush()
    broadcastSnapshot(dependencies.store.getSnapshot())
  })

  secureHandle('voice:revokeConsent', dependencies, async () => {
    dependencies.controller.revokeVoiceConsent()
    await dependencies.store.flush()
    broadcastSnapshot(dependencies.store.getSnapshot())
  })

  secureHandle('voice:request', dependencies, (_event, raw) => {
    const result = dependencies.controller.requestVoice(requireBoolean(raw))
    broadcastSnapshot(dependencies.store.getSnapshot())
    return result
  })

  secureHandle('voice:status', dependencies, (_event, raw) => {
    const request = requireRecord(raw)
    const status = request.status
    if (status !== 'off' && status !== 'starting' && status !== 'active' && status !== 'error') {
      throw new Error('invalid voice status')
    }
    dependencies.controller.reportVoiceStatus(
      status,
      request.error === undefined ? undefined : requireString(request.error, 'voice error', 500),
    )
    broadcastSnapshot(dependencies.store.getSnapshot())
  })

  secureHandle('clicker:setArmed', dependencies, (_event, raw) => {
    dependencies.hotkeys.setClickerArmed(requireBoolean(raw))
  })

  secureHandle('presentation:setArmed', dependencies, (_event, raw) => {
    const enabled = requireBoolean(raw)
    const capability = presentationCapability()
    dependencies.store.patchState({ drivePresentation: enabled && capability.ok })
    broadcastSnapshot(dependencies.store.getSnapshot())
  })

  secureHandle('presentation:status', dependencies, () => presentationCapability())

  secureHandle('hotkeys:update', dependencies, (_event, raw) => {
    const bindings = sanitizeHotkeys(raw)
    if (!bindings) throw new Error('invalid hotkey bindings')
    dependencies.hotkeys.rebind(bindings)
  })

  secureHandle('hotkeys:status', dependencies, () => dependencies.hotkeys.getStatus())

  secureHandle('platform:info', dependencies, () => ({
    platform: process.platform,
    displayServer:
      process.platform === 'linux' ? (process.env.XDG_SESSION_TYPE ?? 'unknown') : process.platform,
    contentProtectionSupported: process.platform !== 'linux',
  }))
}

export function unregisterIpc(): void {
  pendingEditorFlush?.finish(false)
  for (const channel of registeredChannels) ipcMain.removeHandler(channel)
  registeredChannels.clear()
}

export async function loadPathOnStartup(
  dependencies: IpcDependencies,
  path: string,
): Promise<boolean> {
  const generation = importGeneration
  try {
    const imported = await dependencies.importer.loadPath(path)
    assertMutationOpen()
    if (generation !== importGeneration) return false
    await dependencies.store.addImportedDocument(imported, true)
    publish(dependencies, true)
    return true
  } catch (error) {
    console.error('[startup-load]', basename(path), formatError(error))
    return false
  }
}

function secureHandle(
  channel: IpcChannel,
  dependencies: IpcDependencies,
  handler: (event: IpcMainInvokeEvent, raw?: unknown) => unknown,
): void {
  ipcMain.handle(channel, async (event, raw) => {
    const senderFrame = event.senderFrame
    if (!senderFrame) throw new Error('unauthorized IPC request')
    const role = getRendererRole(event.sender)
    const expectedUrl = role ? getRendererUrl(role) : null
    const allowed = authorizeIpc(channel, {
      role,
      frameUrl: senderFrame.url,
      expectedUrl,
      isMainFrame: senderFrame === senderFrame.top,
    })
    if (!allowed) throw new Error('unauthorized IPC request')
    if (closingPhase !== 'open') {
      const allowedWhileClosing = channel === 'editor:flushed' || channel === 'app:bootstrap' ||
        (closingPhase === 'flushing' && channel === 'documents:update')
      if (!allowedWhileClosing) throw new Error('Teleprompt is closing; this operation was cancelled')
    }
    const task = Promise.resolve().then(async () => {
      if (channel !== 'editor:flushed') await dependencies.ready
      if (closingPhase !== 'open' && channel !== 'editor:flushed' && channel !== 'app:bootstrap' &&
          !(closingPhase === 'flushing' && channel === 'documents:update')) {
        throw new Error('Teleprompt is closing; this operation was cancelled')
      }
      return handler(event, raw)
    })
    inFlight.add(task)
    try {
      return await task
    } finally {
      inFlight.delete(task)
    }
  })
  registeredChannels.add(channel)
}

async function importOne(dependencies: IpcDependencies, path: string) {
  const generation = importGeneration
  try {
    const imported = await dependencies.importer.loadPath(path)
    assertMutationOpen()
    if (generation !== importGeneration) throw new Error('Document import was cancelled')
    const document = await dependencies.store.addImportedDocument(imported, true)
    publish(dependencies, true)
    return { ok: true, document } as const
  } catch (error) {
    return { ok: false, error: formatError(error) } as const
  }
}

function publish(dependencies: IpcDependencies, includeDocument: boolean): void {
  applyOverlayEffects()
  broadcastSnapshot(dependencies.store.getSnapshot())
  if (includeDocument) broadcastActiveDocument(activeContent(dependencies.store))
  sendControlsEvent('storage:issues', dependencies.store.getIssues())
  sendControlsEvent('recovery:changed', dependencies.store.getUnresolvedDocuments())
}

function activeContent(store: AppStore): DocumentContent | null {
  const document = store.getActiveDocument()
  return document
    ? { id: document.id, revision: document.revision, content: document.content }
    : null
}

function requireRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid request')
  return raw as Record<string, unknown>
}

function requireId(raw: unknown): DocumentId {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).id : raw
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value)) {
    throw new Error('invalid document id')
  }
  return value
}

function requirePath(raw: unknown): string {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).path : raw
  return requireString(value, 'path', 4096)
}

function requireString(raw: unknown, label: string, maxLength: number): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > maxLength) {
    throw new Error(`invalid ${label}`)
  }
  return raw
}

function requireNumber(raw: unknown, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error('invalid number')
  return Math.max(min, Math.min(max, raw))
}

function requireInteger(raw: unknown, min: number, max: number): number {
  return Math.floor(requireNumber(raw, min, max))
}

function requireBoolean(raw: unknown): boolean {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).enabled : raw
  if (typeof value !== 'boolean') throw new Error('invalid boolean')
  return value
}

function requireGeometry(raw: unknown): OverlayGeometry {
  const request = requireRecord(raw)
  return {
    documentId: requireId(request.documentId),
    revision: requireInteger(request.revision, 0, Number.MAX_SAFE_INTEGER),
    bannerMode: requireBoolean(request.bannerMode),
    textH: requireInteger(request.textH, 0, 1_000_000),
    viewportH: requireInteger(request.viewportH, 0, 100_000),
  }
}

function requireContent(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('invalid content')
  return raw
}

function requirePoint(raw: unknown): [number, number] {
  const request = requireRecord(raw)
  return [
    requireNumber(request.screenX, -1_000_000, 1_000_000),
    requireNumber(request.screenY, -1_000_000, 1_000_000),
  ]
}

type ResizeEdge = 'se' | 'sw' | 'ne' | 'nw' | 'n' | 's' | 'e' | 'w'
function requireResizeEdge(raw: unknown): ResizeEdge {
  if (raw === 'se' || raw === 'sw' || raw === 'ne' || raw === 'nw' || raw === 'n' || raw === 's' || raw === 'e' || raw === 'w') {
    return raw
  }
  throw new Error('invalid resize edge')
}

function sanitizeHotkeys(raw: unknown): Record<HotkeyCommand, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const result = { ...DEFAULT_HOTKEYS }
  for (const command of Object.keys(DEFAULT_HOTKEYS) as HotkeyCommand[]) {
    const accelerator = record[command]
    if (typeof accelerator !== 'string' || accelerator.length < 1 || accelerator.length > 79) {
      return null
    }
    result[command] = accelerator
  }
  if (new Set(Object.values(result)).size !== Object.values(result).length) return null
  return result
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
