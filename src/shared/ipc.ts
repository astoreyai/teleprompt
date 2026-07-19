import type {
  AppSnapshot,
  DocumentContent,
  DocumentFormat,
  DocumentId,
  DocumentMeta,
  DocumentUpdateResult,
  OverlaySnapshot,
} from './contracts.js'
import type { HotkeyCommand } from './types.js'

export type RendererRole = 'controls' | 'overlay'

export type PlatformInfo = {
  platform: NodeJS.Platform
  displayServer: string
  contentProtectionSupported: boolean
}

export type PresentationStatus = { ok: boolean; reason?: string }

export type AppAbout = {
  appVersion: string
  electronVersion: string
  nodeVersion: string
  storePath: string
}

export type ControlsBootstrapPayload = {
  snapshot: AppSnapshot
  activeDocument: DocumentContent | null
  startupIssues: string[]
}

export type OverlayBootstrapPayload = {
  snapshot: OverlaySnapshot
  activeDocument: DocumentContent | null
  hasStartupIssues: boolean
}

export type PreferencePatch = Partial<
  Pick<
    AppSnapshot,
    | 'scrollSpeed'
    | 'opacity'
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
    | 'clickThrough'
    | 'hideFromCapture'
    | 'markdown'
    | 'bannerMode'
    | 'bannerPosition'
    | 'editMode'
    | 'clickerStep'
    | 'showChronometer'
    | 'countdownEnabled'
    | 'countdownSeconds'
    | 'showCueHud'
    | 'aboveFullscreen'
    | 'targetMode'
    | 'targetDurationSec'
    | 'targetWpm'
  >
>

export type SaveResult =
  | { ok: true; document: DocumentMeta }
  | {
      ok: false
      reason: 'not-found' | 'cancelled' | 'conflict' | 'invalid-target' | 'write-failed'
      error?: string
    }

export type ControlsApi = {
  bootstrap(): Promise<ControlsBootstrapPayload>
  openFiles(): Promise<{ loaded: DocumentMeta[]; errors: Array<{ name: string; error: string }> }>
  openRecent(path: string): Promise<{ ok: true; document: DocumentMeta } | { ok: false; error: string }>
  openDroppedFile(file: File): Promise<{ ok: true; document: DocumentMeta } | { ok: false; error: string }>
  createDocument(name: string, content: string, format: 'text' | 'markdown' | 'fountain'): Promise<DocumentMeta>
  selectDocument(id: DocumentId): Promise<{ ok: boolean }>
  removeDocument(id: DocumentId, discardDirty: boolean): Promise<{ ok: true } | { ok: false; reason: 'not-found' | 'dirty' }>
  updateDocument(id: DocumentId, expectedRevision: number, content: string): Promise<DocumentUpdateResult>
  saveDocument(id: DocumentId, saveAs?: boolean): Promise<SaveResult>
  reloadDocument(id: DocumentId, discardDirty: boolean): Promise<{ ok: true } | { ok: false; reason: string }>
  togglePlayback(): Promise<{ ok: boolean; reason?: string }>
  restartPlayback(): Promise<void>
  seek(position: number): Promise<void>
  updatePreferences(patch: PreferencePatch): Promise<AppSnapshot>
  setOverlayVisible(visible: boolean): Promise<void>
  requestVoice(enabled: boolean): Promise<{ ok: boolean; reason?: string }>
  grantVoiceConsent(): Promise<void>
  revokeVoiceConsent(): Promise<void>
  reportVoiceStatus(status: 'off' | 'starting' | 'active' | 'error', error?: string): Promise<void>
  setClickerArmed(enabled: boolean): Promise<void>
  setPresentationArmed(enabled: boolean): Promise<void>
  updateHotkeys(bindings: Record<HotkeyCommand, string>): Promise<void>
  getHotkeyStatus(): Promise<{ failed: string[] }>
  getPlatformInfo(): Promise<PlatformInfo>
  getPresentationStatus(): Promise<PresentationStatus>
  resetPreferences(): Promise<AppSnapshot>
  clearRecentFiles(): Promise<AppSnapshot>
  exportPreferences(): Promise<{ ok: boolean; path?: string; error?: string }>
  importPreferences(): Promise<{ ok: boolean; error?: string }>
  getAbout(): Promise<AppAbout>
  onSnapshot(callback: (snapshot: AppSnapshot) => void): () => void
  onActiveDocument(callback: (document: DocumentContent | null) => void): () => void
  onProgress(callback: (position: number) => void): () => void
  onOverlayGeometry(callback: (geometry: { textH: number; viewportH: number }) => void): () => void
}

export type OverlayApi = {
  bootstrap(): Promise<OverlayBootstrapPayload>
  togglePlayback(): Promise<{ ok: boolean; reason?: string }>
  focusControls(): Promise<void>
  checkpoint(input: {
    documentId: DocumentId
    revision: number
    sessionId: string
    position: number
    terminal: boolean
  }): Promise<{ ok: boolean; reason?: string }>
  reportGeometry(geometry: { textH: number; viewportH: number }): Promise<void>
  dragStart(screenX: number, screenY: number): Promise<void>
  dragUpdate(screenX: number, screenY: number): Promise<void>
  dragEnd(): Promise<void>
  resizeStart(screenX: number, screenY: number, edge: string): Promise<void>
  resizeUpdate(screenX: number, screenY: number): Promise<void>
  resizeEnd(): Promise<void>
  openEditor(): Promise<void>
  onSnapshot(callback: (snapshot: OverlaySnapshot) => void): () => void
  onActiveDocument(callback: (document: DocumentContent | null) => void): () => void
}

export type SupportedCreateFormat = Extract<DocumentFormat, 'text' | 'markdown' | 'fountain'>
