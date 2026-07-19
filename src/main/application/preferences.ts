import type { AppSnapshot } from '../../shared/contracts.js'
import type { PreferencePatch } from '../../shared/ipc.js'

const FONT_FAMILIES = new Set([
  'Inter, system-ui, sans-serif',
  'Georgia, serif',
  'ui-monospace, monospace',
  "'Helvetica Neue', Arial, sans-serif",
  "'Times New Roman', serif",
  'OpenDyslexic, sans-serif',
])

export function sanitizePreferencePatch(raw: unknown): PreferencePatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const value = raw as Record<string, unknown>
  const patch: PreferencePatch = {}
  assignNumber(patch, value, 'scrollSpeed', 1, 2000)
  assignNumber(patch, value, 'opacity', 0.05, 1)
  assignNumber(patch, value, 'bgDim', 0, 1)
  assignNumber(patch, value, 'fontSize', 8, 400)
  assignNumber(patch, value, 'eyeLinePosition', 0.05, 0.95)
  assignNumber(patch, value, 'clickerStep', 0.001, 1)
  assignInteger(patch, value, 'countdownSeconds', 0, 10)
  if (typeof value.fontFamily === 'string' && FONT_FAMILIES.has(value.fontFamily)) {
    patch.fontFamily = value.fontFamily
  }
  if (typeof value.fontColor === 'string' && /^#[0-9a-f]{6}$/i.test(value.fontColor)) {
    patch.fontColor = value.fontColor.toLowerCase()
  }
  if (value.bannerPosition === 'top' || value.bannerPosition === 'bottom') {
    patch.bannerPosition = value.bannerPosition
  }
  if (value.targetMode === null || value.targetMode === 'duration' || value.targetMode === 'wpm') {
    patch.targetMode = value.targetMode
  }
  if (value.targetDurationSec === null) patch.targetDurationSec = null
  else assignNumber(patch, value, 'targetDurationSec', 1, 36_000)
  if (value.targetWpm === null) patch.targetWpm = null
  else assignNumber(patch, value, 'targetWpm', 1, 2000)
  for (const key of BOOLEAN_KEYS) {
    if (typeof value[key] === 'boolean') (patch[key] as boolean) = value[key] as boolean
  }
  return patch
}

export function exportablePreferences(snapshot: AppSnapshot): {
  version: 1
  preferences: PreferencePatch
  hotkeyBindings: AppSnapshot['hotkeyBindings']
} {
  const preferences = sanitizePreferencePatch(snapshot)
  delete preferences.editMode
  return {
    version: 1,
    preferences,
    hotkeyBindings: { ...snapshot.hotkeyBindings },
  }
}

const BOOLEAN_KEYS = [
  'textShadow',
  'mirrorH',
  'mirrorV',
  'showEyeLine',
  'focusMode',
  'clickThrough',
  'hideFromCapture',
  'markdown',
  'bannerMode',
  'editMode',
  'showChronometer',
  'countdownEnabled',
  'showCueHud',
  'aboveFullscreen',
] as const satisfies ReadonlyArray<keyof PreferencePatch>

function assignNumber<K extends keyof PreferencePatch>(
  target: PreferencePatch,
  source: Record<string, unknown>,
  key: K,
  min: number,
  max: number,
): void {
  const value = source[key as string]
  if (typeof value === 'number' && Number.isFinite(value)) {
    target[key] = Math.max(min, Math.min(max, value)) as PreferencePatch[K]
  }
}

function assignInteger<K extends keyof PreferencePatch>(
  target: PreferencePatch,
  source: Record<string, unknown>,
  key: K,
  min: number,
  max: number,
): void {
  assignNumber(target, source, key, min, max)
  const current = target[key]
  if (typeof current === 'number') target[key] = Math.floor(current) as PreferencePatch[K]
}
