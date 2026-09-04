import { randomUUID } from 'node:crypto'
import type { AppSnapshot, DocumentId, DocumentRecord } from '../../shared/contracts.js'
import { MAX_VOICE_PACING_CHARS } from '../../shared/text.js'

export type ControllerStateStore = {
  getSnapshot(): AppSnapshot
  getActiveDocument(): DocumentRecord | null
  patchState(
    patch: Partial<Omit<AppSnapshot, 'schemaVersion' | 'documents' | 'activeDocumentId'>>,
  ): AppSnapshot
  selectDocument(id: DocumentId): boolean
}

export class AppController {
  constructor(
    private readonly store: ControllerStateStore,
    private readonly createSessionId: () => string = randomUUID,
  ) {}

  play(): { ok: true; sessionId: string } | { ok: false; reason: 'no-document' } {
    if (!this.store.getActiveDocument()) return { ok: false, reason: 'no-document' }
    const sessionId = this.createSessionId()
    this.store.patchState({
      playing: true,
      playbackSessionId: sessionId,
      seekGeneration: 0,
      voicePacing: false,
      voiceStatus: 'off',
      voiceError: null,
    })
    return { ok: true, sessionId }
  }

  pause(): AppSnapshot {
    return this.store.patchState({ playing: false, playbackSessionId: null })
  }

  togglePlayback(): { ok: true; sessionId?: string } | { ok: false; reason: 'no-document' } {
    if (this.store.getSnapshot().playing) {
      this.pause()
      return { ok: true }
    }
    return this.play()
  }

  restart(): AppSnapshot {
    return this.store.patchState({
      playing: false,
      playbackSessionId: null,
      scrollPosition: 0,
    })
  }

  seek(position: number): AppSnapshot {
    const next = Number.isFinite(position) ? Math.max(0, Math.min(1, position)) : 0
    return this.store.patchState({
      scrollPosition: next,
      seekGeneration: this.store.getSnapshot().seekGeneration + 1,
      ...(next >= 1 ? { playing: false, playbackSessionId: null } : {}),
    })
  }

  selectDocument(id: DocumentId): boolean {
    this.pause()
    return this.store.selectDocument(id)
  }

  checkpoint(input: {
    documentId: DocumentId
    revision: number
    sessionId: string
    seekGeneration: number
    position: number
    terminal: boolean
  }): { ok: true } | { ok: false; reason: 'stale' | 'invalid' } {
    if (!Number.isFinite(input.position)) return { ok: false, reason: 'invalid' }
    const snapshot = this.store.getSnapshot()
    const active = this.store.getActiveDocument()
    if (
      !snapshot.playing ||
      !active ||
      active.id !== input.documentId ||
      active.revision !== input.revision ||
      snapshot.playbackSessionId !== input.sessionId ||
      snapshot.seekGeneration !== input.seekGeneration
    ) {
      return { ok: false, reason: 'stale' }
    }
    const position = Math.max(0, Math.min(1, input.position))
    this.store.patchState({
      scrollPosition: position,
      ...(input.terminal || position >= 1
        ? { playing: false, playbackSessionId: null }
        : {}),
    })
    return { ok: true }
  }

  requestVoice(enabled: boolean):
    | { ok: true }
    | { ok: false; reason: 'consent-required' | 'no-document' | 'document-too-large' } {
    if (!enabled) {
      this.store.patchState({
        voicePacing: false,
        voiceStatus: 'off',
        voiceError: null,
      })
      return { ok: true }
    }
    const snapshot = this.store.getSnapshot()
    if (!snapshot.voiceConsent) return { ok: false, reason: 'consent-required' }
    const document = this.store.getActiveDocument()
    if (!document) return { ok: false, reason: 'no-document' }
    if (document.content.length > MAX_VOICE_PACING_CHARS) {
      return { ok: false, reason: 'document-too-large' }
    }
    this.store.patchState({
      playing: false,
      playbackSessionId: null,
      voicePacing: true,
      voiceStatus: 'starting',
      voiceError: null,
    })
    return { ok: true }
  }

  grantVoiceConsent(): AppSnapshot {
    return this.store.patchState({ voiceConsent: true })
  }

  revokeVoiceConsent(): AppSnapshot {
    return this.store.patchState({
      voiceConsent: false,
      voicePacing: false,
      voiceStatus: 'off',
      voiceError: null,
    })
  }

  reportVoiceStatus(
    status: 'off' | 'starting' | 'active' | 'error',
    error?: string,
  ): AppSnapshot {
    const snapshot = this.store.getSnapshot()
    const document = this.store.getActiveDocument()
    const activeTransitionAllowed =
      snapshot.voiceConsent &&
      snapshot.voicePacing &&
      !!document &&
      document.content.length <= MAX_VOICE_PACING_CHARS
    if (
      ((status === 'starting' || status === 'active') && !activeTransitionAllowed) ||
      (status === 'error' && !snapshot.voicePacing)
    ) {
      return this.store.patchState({
        voicePacing: false,
        voiceStatus: 'off',
        voiceError: null,
      })
    }
    return this.store.patchState({
      voicePacing: status === 'starting' || status === 'active',
      voiceStatus: status,
      voiceError: status === 'error' ? (error ?? 'voice recognition failed').slice(0, 500) : null,
    })
  }
}
