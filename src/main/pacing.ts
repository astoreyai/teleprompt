import { stripCues } from '../shared/cues.js'
import { getState, setState } from './store.js'

let lastGeom: { textH: number; viewportH: number } = { textH: 0, viewportH: 0 }

export function setLastGeom(g: { textH: number; viewportH: number }): void {
  lastGeom = g
}

export function getLastGeom() {
  return lastGeom
}

const WORD_RE = /[A-Za-z0-9À-ɏЀ-ӿ֐-׿؀-ۿ']+/g

function countWords(s: string): number {
  return (s.match(WORD_RE) || []).length
}

export function applyPacingTarget(): boolean {
  const s = getState()
  if (!s.targetMode) return false
  const range = Math.max(0, lastGeom.textH - lastGeom.viewportH)
  if (range <= 0) return false
  const file = s.files[s.currentFileIndex]
  const words = file ? countWords(stripCues(file.content)) : 0

  let newSpeed: number | null = null
  if (s.targetMode === 'duration' && s.targetDurationSec && s.targetDurationSec > 0) {
    newSpeed = range / s.targetDurationSec
  } else if (
    s.targetMode === 'wpm' &&
    s.targetWpm &&
    s.targetWpm > 0 &&
    words > 0
  ) {
    newSpeed = (range * s.targetWpm) / (words * 60)
  }

  if (newSpeed === null) return false
  const clamped = Math.max(1, Math.min(2000, newSpeed))
  if (Math.abs(clamped - s.scrollSpeed) > 0.5) {
    setState({ scrollSpeed: clamped })
    return true
  }
  return false
}
