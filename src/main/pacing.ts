import { stripCues } from '../shared/cues.js'
import { countWords } from '../shared/text.js'
import type { AppStore } from './application/app-store.js'

export class PacingService {
  private geometry = { textH: 0, viewportH: 0 }

  constructor(private readonly store: AppStore) {}

  setGeometry(geometry: { textH: number; viewportH: number }): boolean {
    this.geometry = {
      textH: Math.max(0, Math.floor(geometry.textH)),
      viewportH: Math.max(0, Math.floor(geometry.viewportH)),
    }
    return this.applyTarget()
  }

  getGeometry(): { textH: number; viewportH: number } {
    return { ...this.geometry }
  }

  applyTarget(): boolean {
    const snapshot = this.store.getSnapshot()
    if (!snapshot.targetMode) return false
    const range = Math.max(0, this.geometry.textH - this.geometry.viewportH)
    if (range <= 0) return false
    const document = this.store.getActiveDocument()
    const words = document ? countWords(stripCues(document.content)) : 0
    let speed: number | null = null
    if (
      snapshot.targetMode === 'duration' &&
      snapshot.targetDurationSec &&
      snapshot.targetDurationSec > 0
    ) {
      speed = range / snapshot.targetDurationSec
    } else if (
      snapshot.targetMode === 'wpm' &&
      snapshot.targetWpm &&
      snapshot.targetWpm > 0 &&
      words > 0
    ) {
      speed = (range * snapshot.targetWpm) / (words * 60)
    }
    if (speed === null) return false
    const clamped = Math.max(1, Math.min(2000, speed))
    if (Math.abs(clamped - snapshot.scrollSpeed) <= 0.5) return false
    this.store.patchState({ scrollSpeed: clamped })
    return true
  }
}
