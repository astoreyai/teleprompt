import Store from 'electron-store'
import { readFileSync, realpathSync } from 'node:fs'
import { basename } from 'node:path'
import { DEFAULT_HOTKEYS, type AppState, type ScriptFile } from '../shared/types.js'

const defaults: AppState = {
  files: [],
  currentFileIndex: 0,
  scrollPosition: 0,
  scrollSpeed: 60,
  playing: false,
  opacity: 0.85,
  bgDim: 0.4,
  fontSize: 48,
  fontFamily: 'Inter, system-ui, sans-serif',
  fontColor: '#ffffff',
  textShadow: true,
  mirrorH: false,
  mirrorV: false,
  eyeLinePosition: 0.4,
  showEyeLine: true,
  focusMode: false,
  clickThrough: false,
  hideFromCapture: false,
  voicePacing: false,
  markdown: false,
  bannerMode: false,
  bannerPosition: 'bottom',
  editMode: false,
  clickerMode: false,
  clickerStep: 0.05,
  showChronometer: true,
  voiceConsent: false,
  countdownEnabled: false,
  countdownSeconds: 3,
  showCueHud: false,
  drivePresentation: false,
  aboveFullscreen: false,
  targetMode: null,
  targetDurationSec: null,
  targetWpm: null,
  hotkeyBindings: { ...DEFAULT_HOTKEYS },
  recentFiles: [],
  overlayBounds: { x: 100, y: 100, width: 900, height: 600 },
  controlsBounds: { x: 100, y: 750, width: 900, height: 400 },
}

type Persisted = Omit<AppState, 'files' | 'scrollPosition' | 'playing' | 'editMode'> & {
  filePaths: string[]
}

function persistedFrom(s: AppState): Persisted {
  const { files: _f, scrollPosition: _s, playing: _p, editMode: _e, ...rest } = s
  return {
    ...rest,
    filePaths: s.files.map((f) => f.path).filter((p) => typeof p === 'string' && !p.startsWith('mem://')),
  }
}

const persistedDefaults: Persisted = persistedFrom(defaults)

const store = new Store<Persisted>({ name: 'teleprompt-state', defaults: persistedDefaults })

function loadOne(path: string): ScriptFile | null {
  try {
    const content = readFileSync(path, 'utf8')
    return { path, name: basename(path), content }
  } catch {
    return null
  }
}

function clampIndex(i: number, len: number): number {
  if (!Number.isFinite(i) || i < 0) return 0
  if (len === 0) return 0
  return Math.min(Math.floor(i), len - 1)
}

function validatePersisted(raw: unknown): Persisted {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  let filePaths = r.filePaths
  if (!Array.isArray(filePaths)) {
    const legacy = (r as { files?: unknown }).files
    if (Array.isArray(legacy)) {
      filePaths = legacy
        .map((f) => (f && typeof f === 'object' ? (f as Record<string, unknown>).path : null))
        .filter((p): p is string => typeof p === 'string' && !p.startsWith('mem://'))
    } else {
      filePaths = []
    }
  }
  const out: Persisted = {
    ...persistedDefaults,
    ...(r as Partial<Persisted>),
    filePaths: (filePaths as string[]).filter((p) => typeof p === 'string'),
    recentFiles: Array.isArray(r.recentFiles) ? (r.recentFiles as string[]).filter((p) => typeof p === 'string') : [],
  }
  return out
}

function buildRuntime(p: Persisted): AppState {
  const files: ScriptFile[] = []
  for (const path of p.filePaths) {
    const f = loadOne(path)
    if (f) files.push(f)
  }
  const { filePaths: _fp, ...rest } = p
  return {
    ...defaults,
    ...rest,
    files,
    currentFileIndex: clampIndex(rest.currentFileIndex ?? 0, files.length),
    scrollPosition: 0,
    playing: false,
    editMode: false,
  }
}

let runtime: AppState = buildRuntime(validatePersisted(store.store))

let persistTimer: NodeJS.Timeout | null = null
function schedulePersist() {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    store.store = persistedFrom(runtime)
  }, 250)
}

export function getState(): AppState {
  return runtime
}

export function setState(patch: Partial<AppState>): AppState {
  runtime = { ...runtime, ...patch }
  schedulePersist()
  return runtime
}

function canonicalize(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export function pushRecent(path: string, max = 10): string[] {
  if (typeof path !== 'string' || !path) return runtime.recentFiles
  const canon = canonicalize(path)
  const next = [
    canon,
    ...runtime.recentFiles.filter((p) => p !== canon && canonicalize(p) !== canon),
  ].slice(0, max)
  runtime = { ...runtime, recentFiles: next }
  schedulePersist()
  return next
}

export function flushPersist(): void {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  store.store = persistedFrom(runtime)
}

export function resetState(): AppState {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  store.store = persistedDefaults
  runtime = buildRuntime(persistedDefaults)
  return runtime
}

export function exportPersisted(): Persisted {
  return persistedFrom(runtime)
}

export function importPersisted(raw: unknown): AppState {
  const validated = validatePersisted(raw)
  store.store = validated
  runtime = buildRuntime(validated)
  return runtime
}

export function getStorePath(): string {
  return store.path
}
