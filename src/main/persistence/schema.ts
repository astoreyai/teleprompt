import { basename } from 'node:path'
import type {
  AppSnapshot,
  DocumentFormat,
  DocumentMeta,
} from '../../shared/contracts.js'
import { STATE_SCHEMA_VERSION } from '../../shared/contracts.js'
import { createDefaultSnapshot } from '../../shared/defaults.js'
import { DEFAULT_HOTKEYS, type Bounds, type HotkeyCommand } from '../../shared/types.js'
import { classifyDocumentPath } from '../files/file-policy.js'

export type PersistedSettings = Omit<
  AppSnapshot,
  | 'schemaVersion'
  | 'documents'
  | 'activeDocumentId'
  | 'playing'
  | 'editMode'
  | 'voicePacing'
  | 'clickerMode'
  | 'drivePresentation'
  | 'playbackSessionId'
  | 'seekGeneration'
  | 'overlayVisible'
  | 'voiceStatus'
  | 'voiceError'
>

export type PersistedDocumentRef = Omit<DocumentMeta, 'saveMode'>

export type PersistedStateV2 = {
  version: typeof STATE_SCHEMA_VERSION
  state: PersistedSettings
  documentRefs: PersistedDocumentRef[]
  activeDocumentId: string | null
}

export type ParsedPersistedState = {
  value: PersistedStateV2
  migrated: boolean
  quarantined: boolean
  issues: string[]
}

const MAX_PATH_LENGTH = 4096
const MAX_DOCUMENTS = 100
const FONT_FAMILIES = new Set([
  'Inter, system-ui, sans-serif',
  'Georgia, serif',
  'ui-monospace, monospace',
  "'Helvetica Neue', Arial, sans-serif",
  "'Times New Roman', serif",
  'OpenDyslexic, sans-serif',
])
const DOCUMENT_FORMATS = new Set<DocumentFormat>([
  'text',
  'markdown',
  'fountain',
  'rtf',
  'docx',
  'odt',
  'pdf',
  'html',
  'subtitle',
])

export function persistedFromSnapshot(snapshot: AppSnapshot): PersistedStateV2 {
  const {
    schemaVersion: _schemaVersion,
    documents,
    activeDocumentId,
    playing: _playing,
    editMode: _editMode,
    voicePacing: _voicePacing,
    clickerMode: _clickerMode,
    drivePresentation: _drivePresentation,
    playbackSessionId: _playbackSessionId,
    seekGeneration: _seekGeneration,
    overlayVisible: _overlayVisible,
    voiceStatus: _voiceStatus,
    voiceError: _voiceError,
    ...state
  } = snapshot
  return {
    version: STATE_SCHEMA_VERSION,
    state: cloneSettings(state),
    documentRefs: documents.map(({ saveMode: _saveMode, ...document }) => ({ ...document })),
    activeDocumentId,
  }
}

export function parsePersistedState(raw: unknown): ParsedPersistedState {
  if (raw === null || raw === undefined) {
    return {
      value: emptyPersisted(),
      migrated: false,
      quarantined: false,
      issues: [],
    }
  }
  const record = asRecord(raw)
  const rawVersion = record?.version
  if (typeof rawVersion === 'number' && rawVersion !== STATE_SCHEMA_VERSION) {
    return {
      value: emptyPersisted(),
      migrated: false,
      quarantined: true,
      issues: [`unsupported state version ${rawVersion}`],
    }
  }
  if (rawVersion === STATE_SCHEMA_VERSION && record) return parseV2(record)
  return migrateLegacy(record ?? {})
}

function parseV2(record: Record<string, unknown>): ParsedPersistedState {
  const issues: string[] = []
  const documentRefs = parseDocumentRefs(record.documentRefs, issues)
  const state = parseSettings(record.state, documentRefs.length, issues)
  const requestedActive = typeof record.activeDocumentId === 'string' ? record.activeDocumentId : null
  const activeDocumentId = documentRefs.some((document) => document.id === requestedActive)
    ? requestedActive
    : (documentRefs[0]?.id ?? null)
  if (requestedActive && requestedActive !== activeDocumentId) issues.push('active document was missing')
  return {
    value: { version: STATE_SCHEMA_VERSION, state, documentRefs, activeDocumentId },
    migrated: false,
    quarantined: false,
    issues,
  }
}

function migrateLegacy(record: Record<string, unknown>): ParsedPersistedState {
  const issues = ['migrated legacy 0.1.x state']
  const paths = legacyPaths(record).slice(0, MAX_DOCUMENTS)
  const documentRefs: PersistedDocumentRef[] = paths.flatMap((sourcePath, index) => {
    const format = classifyDocumentPath(sourcePath)
    if (!format) {
      issues.push(`unsupported legacy document: ${basename(sourcePath)}`)
      return []
    }
    return [
      {
        id: `legacy-${hashPath(sourcePath)}-${index}`,
        name: basename(sourcePath).slice(0, 200),
        sourcePath,
        format,
        revision: 0,
        dirty: false,
        sourceMtimeMs: null,
        sourceHash: null,
      },
    ]
  })
  const state = parseSettings(record, documentRefs.length, issues)
  const index = integerInRange(record.currentFileIndex, 0, Math.max(0, documentRefs.length - 1), 0)
  return {
    value: {
      version: STATE_SCHEMA_VERSION,
      state,
      documentRefs,
      activeDocumentId: documentRefs[index]?.id ?? null,
    },
    migrated: true,
    quarantined: false,
    issues,
  }
}

function parseSettings(raw: unknown, documentCount: number, issues: string[]): PersistedSettings {
  const source = asRecord(raw) ?? {}
  const defaults = persistedFromSnapshot(createDefaultSnapshot()).state
  const state: PersistedSettings = {
    ...defaults,
    scrollPosition: documentCount > 0 ? numberInRange(source.scrollPosition, 0, 1, defaults.scrollPosition) : 0,
    scrollSpeed: numberInRange(source.scrollSpeed, 1, 2000, defaults.scrollSpeed),
    opacity: numberInRange(source.opacity, 0.05, 1, defaults.opacity),
    bgDim: numberInRange(source.bgDim, 0, 1, defaults.bgDim),
    fontSize: numberInRange(source.fontSize, 8, 400, defaults.fontSize),
    fontFamily:
      typeof source.fontFamily === 'string' && FONT_FAMILIES.has(source.fontFamily)
        ? source.fontFamily
        : defaults.fontFamily,
    fontColor:
      typeof source.fontColor === 'string' && /^#[0-9a-f]{6}$/i.test(source.fontColor)
        ? source.fontColor.toLowerCase()
        : defaults.fontColor,
    eyeLinePosition: numberInRange(source.eyeLinePosition, 0.05, 0.95, defaults.eyeLinePosition),
    clickerStep: numberInRange(source.clickerStep, 0.001, 1, defaults.clickerStep),
    countdownSeconds: integerInRange(source.countdownSeconds, 0, 10, defaults.countdownSeconds),
    targetDurationSec: nullableNumberInRange(source.targetDurationSec, 1, 36_000),
    targetWpm: nullableNumberInRange(source.targetWpm, 1, 2000),
    bannerPosition:
      source.bannerPosition === 'top' || source.bannerPosition === 'bottom'
        ? source.bannerPosition
        : defaults.bannerPosition,
    targetMode:
      source.targetMode === 'duration' || source.targetMode === 'wpm'
        ? source.targetMode
        : null,
    hotkeyBindings: parseHotkeys(source.hotkeyBindings),
    recentFiles: parseRecentFiles(source.recentFiles),
    overlayBounds: parseBounds(source.overlayBounds, defaults.overlayBounds, 200, 80),
    controlsBounds: parseBounds(source.controlsBounds, defaults.controlsBounds, 560, 360),
  }
  for (const key of BOOLEAN_SETTINGS) {
    if (typeof source[key] === 'boolean') (state[key] as boolean) = source[key] as boolean
  }
  if (state.targetMode === 'duration' && state.targetDurationSec === null) state.targetMode = null
  if (state.targetMode === 'wpm' && state.targetWpm === null) state.targetMode = null
  if (Object.keys(source).length > 0 && JSON.stringify(state) !== JSON.stringify(source)) {
    issues.push('invalid settings were normalized')
  }
  return state
}

const BOOLEAN_SETTINGS = [
  'textShadow',
  'mirrorH',
  'mirrorV',
  'showEyeLine',
  'focusMode',
  'clickThrough',
  'hideFromCapture',
  'markdown',
  'bannerMode',
  'showChronometer',
  'voiceConsent',
  'countdownEnabled',
  'showCueHud',
  'aboveFullscreen',
] as const satisfies ReadonlyArray<keyof PersistedSettings>

function parseDocumentRefs(raw: unknown, issues: string[]): PersistedDocumentRef[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const result: PersistedDocumentRef[] = []
  for (const item of raw.slice(0, MAX_DOCUMENTS)) {
    const record = asRecord(item)
    if (!record) continue
    const id = safeId(record.id)
    const sourcePath = safePathOrNull(record.sourcePath)
    const format = DOCUMENT_FORMATS.has(record.format as DocumentFormat)
      ? (record.format as DocumentFormat)
      : sourcePath
        ? classifyDocumentPath(sourcePath)
        : null
    if (!id || seen.has(id) || !format) {
      issues.push('invalid document reference was discarded')
      continue
    }
    seen.add(id)
    result.push({
      id,
      name:
        typeof record.name === 'string' && record.name.length > 0
          ? record.name.slice(0, 200)
          : sourcePath
            ? basename(sourcePath).slice(0, 200)
            : 'Recovered draft',
      sourcePath,
      format,
      revision: integerInRange(record.revision, 0, Number.MAX_SAFE_INTEGER, 0),
      dirty: record.dirty === true || sourcePath === null,
      sourceMtimeMs:
        typeof record.sourceMtimeMs === 'number' && Number.isFinite(record.sourceMtimeMs)
          ? Math.max(0, record.sourceMtimeMs)
          : null,
      sourceHash:
        typeof record.sourceHash === 'string' && /^[0-9a-f]{64}$/i.test(record.sourceHash)
          ? record.sourceHash.toLowerCase()
          : null,
    })
  }
  return result
}

function legacyPaths(record: Record<string, unknown>): string[] {
  const source = Array.isArray(record.filePaths)
    ? record.filePaths
    : Array.isArray(record.files)
      ? record.files.map((item) => asRecord(item)?.path)
      : []
  return source
    .filter((path): path is string => typeof path === 'string')
    .map((path) => path.slice(0, MAX_PATH_LENGTH))
    .filter((path) => path.length > 0 && !path.startsWith('mem://'))
}

function parseRecentFiles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((path): path is string => typeof path === 'string'))]
    .map((path) => path.slice(0, MAX_PATH_LENGTH))
    .filter((path) => path.length > 0 && !path.startsWith('mem://'))
    .slice(0, 10)
}

function parseHotkeys(raw: unknown): Record<HotkeyCommand, string> {
  const record = asRecord(raw) ?? {}
  const result = { ...DEFAULT_HOTKEYS }
  for (const command of Object.keys(DEFAULT_HOTKEYS) as HotkeyCommand[]) {
    const accelerator = record[command]
    if (typeof accelerator === 'string' && accelerator.length > 0 && accelerator.length < 80) {
      result[command] = accelerator
    }
  }
  return result
}

function parseBounds(raw: unknown, fallback: Bounds, minWidth: number, minHeight: number): Bounds {
  const record = asRecord(raw) ?? {}
  return {
    x: finiteNumber(record.x, fallback.x),
    y: finiteNumber(record.y, fallback.y),
    width: numberInRange(record.width, minWidth, 8000, fallback.width),
    height: numberInRange(record.height, minHeight, 8000, fallback.height),
  }
}

function emptyPersisted(): PersistedStateV2 {
  return persistedFromSnapshot(createDefaultSnapshot())
}

function cloneSettings(settings: PersistedSettings): PersistedSettings {
  return {
    ...settings,
    hotkeyBindings: { ...settings.hotkeyBindings },
    recentFiles: [...settings.recentFiles],
    overlayBounds: { ...settings.overlayBounds },
    controlsBounds: { ...settings.controlsBounds },
  }
}

function safePathOrNull(raw: unknown): string | null {
  if (raw === null) return null
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH_LENGTH) return null
  if (raw.startsWith('mem://')) return null
  return raw
}

function safeId(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 128) return null
  return /^[a-zA-Z0-9._:-]+$/.test(raw) ? raw : null
}

function numberInRange(raw: unknown, min: number, max: number, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  return Math.max(min, Math.min(max, raw))
}

function integerInRange(raw: unknown, min: number, max: number, fallback: number): number {
  return Math.floor(numberInRange(raw, min, max, fallback))
}

function nullableNumberInRange(raw: unknown, min: number, max: number): number | null {
  if (raw === null || raw === undefined) return null
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= min
    ? Math.min(max, raw)
    : null
}

function finiteNumber(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null
}

function hashPath(path: string): string {
  let hash = 2_166_136_261
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0).toString(36)
}
