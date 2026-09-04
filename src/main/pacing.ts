import type { OverlayGeometry } from '../shared/ipc.js'
import { stripCues } from '../shared/cues.js'
import { countWords } from '../shared/text.js'
import type { AppStore } from './application/app-store.js'

export class PacingService {
  private geometry: OverlayGeometry | null = null
  private wordCache: { id: string; revision: number; words: number } | null = null

  constructor(private readonly store: AppStore) {}

  setGeometry(geometry: OverlayGeometry): boolean {
    const snapshot = this.store.getSnapshot()
    const document = this.store.getActiveDocument()
    if (!document || geometry.documentId !== document.id || geometry.revision !== document.revision ||
      geometry.bannerMode !== snapshot.bannerMode || !Number.isFinite(geometry.textH) || !Number.isFinite(geometry.viewportH)) return false
    this.geometry = { ...geometry, textH: Math.max(0, geometry.textH), viewportH: Math.max(0, geometry.viewportH) }
    return this.applyTarget()
  }

  getGeometry(): { textH: number; viewportH: number } {
    const document = this.store.getActiveDocument()
    const geometry = this.geometry
    if (!document || !geometry || geometry.documentId !== document.id ||
      geometry.revision !== document.revision || geometry.bannerMode !== this.store.getSnapshot().bannerMode) {
      return { textH: 0, viewportH: 0 }
    }
    return { textH: geometry.textH, viewportH: geometry.viewportH }
  }

  applyTarget(): boolean {
    const snapshot = this.store.getSnapshot()
    if (!snapshot.targetMode) return false
    const geometry = this.getGeometry()
    const range = Math.max(0, geometry.textH - geometry.viewportH)
    if (range <= 0) return false
    const document = this.store.getActiveDocument()
    if (!document) return false
    if (this.wordCache?.id !== document.id || this.wordCache.revision !== document.revision) {
      this.wordCache = { id: document.id, revision: document.revision, words: countWords(stripCues(document.content)) }
    }
    const words = this.wordCache.words
    let speed: number | null = null
    if (snapshot.targetMode === 'duration' && snapshot.targetDurationSec && snapshot.targetDurationSec > 0) {
      speed = range / snapshot.targetDurationSec
    } else if (snapshot.targetMode === 'wpm' && snapshot.targetWpm && snapshot.targetWpm > 0 && words > 0) {
      speed = (range * snapshot.targetWpm) / (words * 60)
    }
    if (speed === null) return false
    const clamped = Math.max(1, Math.min(2000, speed))
    if (Math.abs(clamped - snapshot.scrollSpeed) <= 0.5) return false
    this.store.patchState({ scrollSpeed: clamped })
    return true
  }
}
