export type Bounds = { x: number; y: number; width: number; height: number }

export type BannerPosition = 'top' | 'bottom'

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
