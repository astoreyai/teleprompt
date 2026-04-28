export type ScriptFile = {
  path: string
  name: string
  content: string
}

export type Bounds = { x: number; y: number; width: number; height: number }

export type BannerPosition = 'top' | 'bottom'

export type AppState = {
  files: ScriptFile[]
  currentFileIndex: number
  scrollPosition: number
  scrollSpeed: number
  playing: boolean
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

export type StateChannel = 'state:update' | 'state:patch'

export type IpcApi = {
  getState: () => Promise<AppState>
  patchState: (patch: Partial<AppState>) => Promise<AppState>
  openFiles: () => Promise<ScriptFile[]>
  loadFromPath: (path: string) => Promise<ScriptFile | null>
  loadFromContent: (name: string, content: string, path?: string) => Promise<ScriptFile>
  removeFile: (index: number) => Promise<void>
  selectFile: (index: number) => Promise<void>
  togglePlay: () => Promise<void>
  setScrollPosition: (position: number) => Promise<void>
  reloadCurrent: () => Promise<void>
  updateContent: (index: number, content: string) => Promise<void>
  saveCurrent: () => Promise<{ ok: boolean; error?: string }>
  onState: (cb: (state: AppState) => void) => () => void
  onCommand: (cb: (cmd: HotkeyCommand) => void) => () => void
}

export type HotkeyCommand =
  | 'play-pause'
  | 'speed-up'
  | 'speed-down'
  | 'opacity-up'
  | 'opacity-down'
  | 'next-file'
  | 'prev-file'
  | 'toggle-overlay'
  | 'toggle-click-through'
  | 'restart'

export const DEFAULT_HOTKEYS: Record<HotkeyCommand, string> = {
  'play-pause': 'CommandOrControl+Alt+Space',
  'speed-up': 'CommandOrControl+Alt+Up',
  'speed-down': 'CommandOrControl+Alt+Down',
  'opacity-up': 'CommandOrControl+Alt+]',
  'opacity-down': 'CommandOrControl+Alt+[',
  'next-file': 'CommandOrControl+Alt+Right',
  'prev-file': 'CommandOrControl+Alt+Left',
  'toggle-overlay': 'CommandOrControl+Alt+H',
  'toggle-click-through': 'CommandOrControl+Alt+T',
  'restart': 'CommandOrControl+Alt+R',
}

export const HOTKEY_LABELS: Record<HotkeyCommand, string> = {
  'play-pause': 'Play / Pause',
  'speed-up': 'Speed up',
  'speed-down': 'Speed down',
  'opacity-up': 'Opacity up',
  'opacity-down': 'Opacity down',
  'next-file': 'Next file',
  'prev-file': 'Prev file',
  'toggle-overlay': 'Hide / Show overlay',
  'toggle-click-through': 'Toggle click-through',
  'restart': 'Restart from top',
}
