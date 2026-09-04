import type { BannerPosition, Bounds, HotkeyCommand } from './types.js'

export const STATE_SCHEMA_VERSION = 2 as const

export type DocumentId = string

export type DocumentFormat =
  | 'text'
  | 'markdown'
  | 'fountain'
  | 'rtf'
  | 'docx'
  | 'odt'
  | 'pdf'
  | 'html'
  | 'subtitle'

export type SaveMode = 'overwrite' | 'save-as'

export type DocumentMeta = {
  id: DocumentId
  name: string
  sourcePath: string | null
  format: DocumentFormat
  saveMode: SaveMode
  revision: number
  dirty: boolean
  sourceMtimeMs: number | null
  sourceHash: string | null
}

export type DocumentContent = {
  id: DocumentId
  revision: number
  content: string
}

export type DocumentRecord = DocumentMeta & {
  content: string
}

// This is intentionally content-free. It is safe to broadcast on settings,
// playlist, and playback changes without cloning every script body.
export type AppSnapshot = {
  schemaVersion: typeof STATE_SCHEMA_VERSION
  documents: DocumentMeta[]
  activeDocumentId: DocumentId | null
  scrollPosition: number
  scrollSpeed: number
  playing: boolean
  playbackSessionId: string | null
  seekGeneration: number
  overlayVisible: boolean
  voiceStatus: 'off' | 'starting' | 'active' | 'error'
  voiceError: string | null
  opacity: number
  bgDim: number
  fontSize: number
  fontFamily: string
  fontColor: string
  textShadow: boolean
  mirrorH: boolean
  mirrorV: boolean
  eyeLinePosition: number
  showEyeLine: boolean
  focusMode: boolean
  clickThrough: boolean
  hideFromCapture: boolean
  voicePacing: boolean
  markdown: boolean
  bannerMode: boolean
  bannerPosition: BannerPosition
  editMode: boolean
  clickerMode: boolean
  clickerStep: number
  showChronometer: boolean
  voiceConsent: boolean
  countdownEnabled: boolean
  countdownSeconds: number
  showCueHud: boolean
  drivePresentation: boolean
  aboveFullscreen: boolean
  targetMode: 'duration' | 'wpm' | null
  targetDurationSec: number | null
  targetWpm: number | null
  hotkeyBindings: Record<HotkeyCommand, string>
  recentFiles: string[]
  overlayBounds: Bounds
  controlsBounds: Bounds
}

export type OverlayDocumentMeta = Pick<DocumentMeta, 'id' | 'format' | 'revision'>

export type OverlaySnapshot = Pick<
  AppSnapshot,
  | 'scrollPosition'
  | 'scrollSpeed'
  | 'playing'
  | 'playbackSessionId'
  | 'seekGeneration'
  | 'bgDim'
  | 'fontSize'
  | 'fontFamily'
  | 'fontColor'
  | 'textShadow'
  | 'mirrorH'
  | 'mirrorV'
  | 'eyeLinePosition'
  | 'showEyeLine'
  | 'focusMode'
  | 'markdown'
  | 'bannerMode'
  | 'bannerPosition'
  | 'showChronometer'
  | 'countdownEnabled'
  | 'countdownSeconds'
  | 'showCueHud'
> & {
  activeDocumentMeta: OverlayDocumentMeta | null
}

export type DocumentUpdateResult =
  | { ok: true; revision: number }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'conflict'; currentRevision: number }
  | { ok: false; reason: 'too-large' }
  | { ok: false; reason: 'storage-failed'; error: string }
