import { app, BrowserWindow, crashReporter, dialog, session } from 'electron'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppStore } from './application/app-store.js'
import { AppController } from './application/controller.js'
import { DocumentImportService } from './documents/import-service.js'
import { classifyDocumentPath } from './files/file-policy.js'
import { HotkeyManager } from './hotkeys.js'
import { cancelIpcImports, drainIpcCommands, loadPathOnStartup, registerIpc, setIpcClosing, unregisterIpc, type IpcDependencies } from './ipc.js'
import { purgeOldCrashArtifacts } from './lifecycle/crash-retention.js'
import { logCrash } from './log.js'
import { PacingService } from './pacing.js'
import { spawnElectronParser } from './parser/electron-adapter.js'
import { ParserSupervisor } from './parser/supervisor.js'
import { DraftRepository, MetadataRepository } from './persistence/repositories.js'
import { installRendererProtocol, registerRendererScheme } from './platform/renderer-protocol.js'
import {
  applyOverlayEffects,
  broadcastSnapshot,
  broadcastActiveDocument,
  configureWindowRuntime,
  clampToDisplay,
  createControls,
  createOverlay,
  focusControls,
  stopCursorPoll,
  stopTopReassertPoll,
  stopWindowRecovery,
  sendControlsEvent,
} from './windows.js'

registerRendererScheme()
sanitizeSensitiveEnvironment()

if (process.env.TELEPROMPT_HWACCEL !== '1') app.disableHardwareAcceleration()

try {
  crashReporter.start({ uploadToServer: false, compress: false })
} catch (error) {
  logCrash(`crashReporter.start failed: ${formatError(error)}`)
}

let dependencies: IpcDependencies | null = null
let quitting = false
let quitAfterFlush = false
let quitFlushStarted = false
let fatal = false
const pendingPaths: string[] = []
let controlsClosePending = false

function handleFatal(kind: string, error: unknown): void {
  if (fatal) return
  fatal = true
  quitting = true
  logCrash(`${kind}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  dependencies?.controller.pause()
  dependencies?.hotkeys.unregister()
  dependencies?.importer.dispose()
  stopWindowRecovery()
  unregisterIpc()
  const flush = dependencies?.store.flush() ?? Promise.resolve()
  void Promise.race([flush, delay(1000)])
    .catch((flushError) => logCrash(`fatal flush failed: ${formatError(flushError)}`))
    .finally(() => app.exit(1))
}

process.on('uncaughtException', (error) => handleFatal('uncaughtException', error))
process.on('unhandledRejection', (error) => handleFatal('unhandledRejection', error))
process.on('SIGTERM', () => app.quit())
process.on('SIGINT', () => app.quit())

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  pendingPaths.push(...pickFileArgs(process.argv))

  app.on('second-instance', (_event, argv) => {
    if (quitting) return
    focusControlsIfReady()
    const paths = pickFileArgs(argv)
    if (dependencies) void loadQueuedPaths(paths)
    else pendingPaths.push(...paths)
  })

  app.on('open-file', (event, path) => {
    event.preventDefault()
    if (quitting) return
    if (!classifyDocumentPath(path)) return
    if (dependencies) void loadQueuedPaths([path])
    else pendingPaths.push(path)
  })

  app.whenReady().then(bootstrap).catch((error) => handleFatal('startup', error))
}

async function bootstrap(): Promise<void> {
  installRendererProtocol()
  const userData = app.getPath('userData')
  await purgeOldCrashArtifacts(app.getPath('crashDumps'))
  const metadata = new MetadataRepository({
    directory: userData,
    fileName: 'teleprompt-state.v2.json',
    legacyFileName: 'teleprompt-state.json',
  })
  const drafts = new DraftRepository(resolve(userData, 'drafts'))
  const parserModule = fileURLToPath(new URL('./parser-worker.js', import.meta.url))
  const supervisor = new ParserSupervisor(() => spawnElectronParser(parserModule), {
    timeoutMs: 10_000,
  })
  const importer = new DocumentImportService(supervisor)
  const store = new AppStore({ metadata, drafts, restoreInBackground: true })
  let initialized = false
  const ready = store.initialize(importer).then(() => { initialized = true })
  const controller = new AppController(store)
  const hotkeys = new HotkeyManager(store, controller)
  const pacing = new PacingService(store)
  dependencies = {
    ready,
    store,
    controller,
    importer,
    hotkeys,
    pacing,
  }

  configureWindowRuntime({
    getSnapshot: () => store.getSnapshot(),
    updateBounds: (key, bounds) => {
      if (initialized) store.patchState({ [key]: bounds })
    },
    onRendererGone: (role, _reason) => {
      if (quitting || !initialized) return
      if (role === 'controls' && dependencies) cancelIpcImports(dependencies)
      controller.pause()
      broadcastSnapshot(store.getSnapshot())
    },
    onOverlayVisibilityChanged: (visible) => {
      if (!quitting && initialized) store.patchState({ overlayVisible: visible })
    },
    isQuitting: () => quitting,
    canCloseControls: () => quitAfterFlush || fatal,
    onControlsClose: (window) => { void closeControlsGracefully(window) },
  })

  installPermissionPolicy()
  store.subscribeIssues(() => {
    sendControlsEvent('storage:issues', store.getIssues())
    sendControlsEvent('storage:status', store.getStorageStatus())
    sendControlsEvent('recovery:changed', store.getUnresolvedDocuments())
    broadcastSnapshot(store.getSnapshot())
    const active = store.getActiveDocument()
    broadcastActiveDocument(active ? { id: active.id, revision: active.revision, content: active.content } : null)
  })
  registerIpc(dependencies)
  // Show the existing loading UI while real recovery/import work runs. IPC
  // waits for hydration, so early commands cannot be erased by initialization.
  const controls = createControls()
  await ready
  if (quitting) { importer.dispose(); return }
  if (!controls.isDestroyed()) controls.setBounds(clampToDisplay(store.getSnapshot().controlsBounds, 'controls'))
  createOverlay()
  hotkeys.register()
  applyOverlayEffects()
  await loadQueuedPaths(pendingPaths.splice(0))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createOverlay()
      createControls()
    } else {
      focusControlsIfReady()
    }
  })

  app.on('child-process-gone', (_event, details) => {
    logCrash(
      `child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`,
    )
  })
}

function installPermissionPolicy(): void {
  // This application reads local files and has no microphone or device features.
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
}

async function loadQueuedPaths(paths: string[]): Promise<void> {
  if (quitting) return
  if (!dependencies) {
    pendingPaths.push(...paths)
    return
  }
  await dependencies.ready
  for (const path of [...new Set(paths)]) {
    if (quitting) break
    await loadPathOnStartup(dependencies, path)
  }
}

function focusControlsIfReady(): void {
  if (dependencies) focusControls()
}

app.on('before-quit', (event) => {
  if (quitAfterFlush) return
  event.preventDefault()
  if (quitFlushStarted) return
  quitFlushStarted = true
  quitting = true
  dependencies?.controller.pause()
  dependencies?.hotkeys.unregister()
  void quitGracefully()
})

async function flushForClose(): Promise<void> {
  setIpcClosing('draining')
  if (dependencies) {
    dependencies.store.cancelRestoration()
    cancelIpcImports(dependencies)
  }
  await withDeadline((async () => {
    await dependencies?.ready
    await drainIpcCommands()
    await dependencies?.store.flush()
  })(), 10_000)
}

async function quitGracefully(): Promise<void> {
  try {
    await flushForClose()
  } catch (error) {
    logCrash(`shutdown flush failed: ${formatError(error)}`)
    const choice = await dialog.showMessageBox({
      type: 'warning',
      title: 'Teleprompt could not finish saving',
      message: formatError(error),
      detail: 'Keep Teleprompt open and retry to save the latest playlist and settings. Source files are never modified.',
      buttons: ['Keep open', 'Try again', 'Quit without pending changes'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    if (choice.response === 1) return quitGracefully()
    if (choice.response !== 2) {
      quitting = false
      quitFlushStarted = false
      setIpcClosing('open')
      dependencies?.hotkeys.register()
      return
    }
  }
  dependencies?.importer.dispose()
  stopWindowRecovery()
  unregisterIpc()
  stopCursorPoll()
  stopTopReassertPoll()
  quitAfterFlush = true
  app.quit()
}

async function closeControlsGracefully(window: BrowserWindow): Promise<void> {
  if (controlsClosePending || quitFlushStarted) return
  controlsClosePending = true
  try {
    await flushForClose()
    if (!window.isDestroyed()) window.destroy()
  } catch (error) {
    logCrash(`controls close flush failed: ${formatError(error)}`)
    await dialog.showMessageBox({
      type: 'warning',
      title: 'Settings could not be saved',
      message: formatError(error),
      detail: 'Resolve the settings storage problem, then close the window again. Source files are unchanged.',
      buttons: ['Keep open'],
    })
  } finally {
    controlsClosePending = false
    if (!quitting) setIpcClosing('open')
  }
}

async function withDeadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Saving is taking longer than expected.')), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

app.on('will-quit', () => {
  dependencies?.hotkeys.unregister()
  dependencies?.importer.dispose()
  stopWindowRecovery()
  unregisterIpc()
  stopCursorPoll()
  stopTopReassertPoll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function pickFileArgs(argv: string[]): string[] {
  const result: string[] = []
  for (const argument of argv.slice(1)) {
    if (argument.startsWith('-')) continue
    const path = isAbsolute(argument) ? argument : resolve(argument)
    if (existsSync(path) && classifyDocumentPath(path)) result.push(path)
  }
  return result
}

function sanitizeSensitiveEnvironment(): void {
  const sensitive = /(api.?key|token|secret|password|credential|private.?key)/i
  for (const key of Object.keys(process.env)) {
    if (sensitive.test(key)) delete process.env[key]
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
