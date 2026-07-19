import { app, BrowserWindow, crashReporter, session } from 'electron'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppStore } from './application/app-store.js'
import { AppController } from './application/controller.js'
import { DocumentImportService } from './documents/import-service.js'
import { DocumentSaveService } from './documents/save-service.js'
import { classifyDocumentPath } from './files/file-policy.js'
import { HotkeyManager } from './hotkeys.js'
import { loadPathOnStartup, registerIpc, unregisterIpc, type IpcDependencies } from './ipc.js'
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
  configureWindowRuntime,
  createControls,
  createOverlay,
  focusControls,
  getRendererRole,
  getRendererUrl,
  stopCursorPoll,
  stopTopReassertPoll,
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

function handleFatal(kind: string, error: unknown): void {
  if (fatal) return
  fatal = true
  quitting = true
  logCrash(`${kind}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  dependencies?.controller.pause()
  dependencies?.hotkeys.unregister()
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
    focusControlsIfReady()
    const paths = pickFileArgs(argv)
    if (dependencies) void loadQueuedPaths(paths)
    else pendingPaths.push(...paths)
  })

  app.on('open-file', (event, path) => {
    event.preventDefault()
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
  const store = new AppStore({ metadata, drafts })
  await store.initialize(importer)
  const controller = new AppController(store)
  const hotkeys = new HotkeyManager(store, controller)
  const pacing = new PacingService(store)
  dependencies = {
    store,
    controller,
    importer,
    saver: new DocumentSaveService(),
    hotkeys,
    pacing,
  }

  configureWindowRuntime({
    getSnapshot: () => store.getSnapshot(),
    updateBounds: (key, bounds) => {
      store.patchState({ [key]: bounds })
    },
    onRendererGone: (_role, _reason) => {
      if (quitting) return
      controller.pause()
      broadcastSnapshot(store.getSnapshot())
    },
    onOverlayVisibilityChanged: (visible) => {
      if (!quitting) store.patchState({ overlayVisible: visible })
    },
    isQuitting: () => quitting,
  })

  installPermissionPolicy(store)
  registerIpc(dependencies)
  createOverlay()
  createControls()
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

function installPermissionPolicy(store: AppStore): void {
  const allowed = (
    contents: Electron.WebContents | null,
    permission: string,
    mediaTypes: readonly string[],
    isMainFrame: boolean,
  ): boolean => {
    if (!contents || permission !== 'media' || !isMainFrame) return false
    if (getRendererRole(contents) !== 'controls') return false
    if (contents.getURL() !== getRendererUrl('controls')) return false
    if (mediaTypes.length !== 1 || mediaTypes[0] !== 'audio') return false
    const snapshot = store.getSnapshot()
    return (
      snapshot.voiceConsent &&
      (snapshot.voiceStatus === 'starting' || snapshot.voiceStatus === 'active')
    )
  }

  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => {
    const mediaTypes = details.mediaType ? [details.mediaType] : []
    return allowed(contents, permission, mediaTypes, details.isMainFrame)
  })
  session.defaultSession.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : []
      const requestingUrl = 'requestingUrl' in details ? details.requestingUrl : undefined
      callback(
        allowed(
          contents,
          permission,
          mediaTypes,
          requestingUrl ? requestingUrl === contents.getURL() : true,
        ),
      )
    },
  )
}

async function loadQueuedPaths(paths: string[]): Promise<void> {
  if (!dependencies) {
    pendingPaths.push(...paths)
    return
  }
  for (const path of [...new Set(paths)]) await loadPathOnStartup(dependencies, path)
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
  unregisterIpc()
  stopCursorPoll()
  stopTopReassertPoll()
  const flush = dependencies?.store.flush() ?? Promise.resolve()
  void Promise.race([flush, delay(1500)])
    .catch((flushError) => logCrash(`shutdown flush failed: ${formatError(flushError)}`))
    .finally(() => {
      quitAfterFlush = true
      app.quit()
    })
})

app.on('will-quit', () => {
  dependencies?.hotkeys.unregister()
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
