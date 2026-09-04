import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWorkspace } from '../domain/workspace.js'
import { AppController } from './controller.js'

// Script corpus: unmodified repository README/SECURITY and installed TypeScript declarations.
function loadWorkspace(path = resolve('README.md')) {
  const workspace = createWorkspace()
  const document = workspace.addDocument({
    name: path.split('/').pop()!, sourcePath: path, format: 'text',
    content: readFileSync(path, 'utf8'), sourceMtimeMs: statSync(path).mtimeMs, sourceHash: null,
  })
  return { workspace, document, controller: new AppController(workspace) }
}

describe('application controller playback sessions with real documents', () => {
  it('refuses play without a document', () => {
    expect(new AppController(createWorkspace()).play()).toEqual({ ok: false, reason: 'no-document' })
  })

  it('rejects stale document, revision, and session checkpoints', () => {
    const { workspace, document, controller } = loadWorkspace()
    controller.play()
    const oldSession = workspace.getSnapshot().playbackSessionId!
    controller.pause()
    controller.play()
    const currentSession = workspace.getSnapshot().playbackSessionId!
    const other = loadWorkspace(resolve('SECURITY.md')).document
    const checkpoint = { documentId: document.id, revision: document.revision, sessionId: currentSession,
      seekGeneration: workspace.getSnapshot().seekGeneration, position: 0.5, terminal: false }
    expect(controller.checkpoint({ ...checkpoint, documentId: other.id })).toEqual({ ok: false, reason: 'stale' })
    expect(controller.checkpoint({ ...checkpoint, revision: document.revision - 1 })).toEqual({ ok: false, reason: 'stale' })
    expect(controller.checkpoint({ ...checkpoint, sessionId: oldSession })).toEqual({ ok: false, reason: 'stale' })
    expect(workspace.getSnapshot().scrollPosition).toBe(0)
  })

  it('accepts the active session, pauses deterministically, and completes at the end', () => {
    const { workspace, document, controller } = loadWorkspace()
    controller.play()
    const oldSession = workspace.getSnapshot().playbackSessionId!
    expect(controller.checkpoint({ documentId: document.id, revision: document.revision, sessionId: oldSession,
      seekGeneration: workspace.getSnapshot().seekGeneration, position: 0.4, terminal: false })).toEqual({ ok: true })
    expect(workspace.getSnapshot().scrollPosition).toBe(0.4)
    controller.pause()
    expect(workspace.getSnapshot()).toMatchObject({ playing: false, playbackSessionId: null })
    controller.play()
    expect(workspace.getSnapshot().playbackSessionId).not.toBe(oldSession)
    expect(controller.checkpoint({ documentId: document.id, revision: document.revision,
      sessionId: workspace.getSnapshot().playbackSessionId!, seekGeneration: workspace.getSnapshot().seekGeneration,
      position: 1, terminal: true })).toEqual({ ok: true })
    expect(workspace.getSnapshot()).toMatchObject({ playing: false, playbackSessionId: null, scrollPosition: 1 })
  })

  it('rejects delayed pre-seek progress and terminal checkpoints without restarting the countdown session', () => {
    const { workspace, document, controller } = loadWorkspace()
    controller.play()
    const checkpoint = { documentId: document.id, revision: document.revision,
      sessionId: workspace.getSnapshot().playbackSessionId!, seekGeneration: workspace.getSnapshot().seekGeneration,
      position: 0.8, terminal: false }
    controller.seek(0)
    expect(controller.checkpoint(checkpoint)).toEqual({ ok: false, reason: 'stale' })
    expect(controller.checkpoint({ ...checkpoint, position: 1, terminal: true })).toEqual({ ok: false, reason: 'stale' })
    expect(workspace.getSnapshot()).toMatchObject({ playing: true, playbackSessionId: checkpoint.sessionId, scrollPosition: 0 })
    const generation = workspace.getSnapshot().seekGeneration
    controller.seek(0.001)
    expect(workspace.getSnapshot()).toMatchObject({ scrollPosition: 0.001, seekGeneration: generation + 1 })
  })

  it('revokes microphone consent and stops an active voice session', () => {
    const { workspace, controller } = loadWorkspace()
    controller.grantVoiceConsent()
    expect(controller.requestVoice(true)).toEqual({ ok: true })
    expect(workspace.getSnapshot()).toMatchObject({ voiceConsent: true, voicePacing: true, voiceStatus: 'starting' })
    controller.revokeVoiceConsent()
    expect(workspace.getSnapshot()).toMatchObject({ voiceConsent: false, voicePacing: false, voiceStatus: 'off', voiceError: null })
  })

  it('refuses memory-heavy voice tokenization for an oversized real script', () => {
    const { workspace, controller } = loadWorkspace(resolve('node_modules/typescript/lib/typescript.d.ts'))
    expect(workspace.getActiveDocument()!.content.length).toBeGreaterThan(500_000)
    controller.grantVoiceConsent()
    expect(controller.requestVoice(true)).toEqual({ ok: false, reason: 'document-too-large' })
    expect(workspace.getSnapshot().voicePacing).toBe(false)
  })

  it('does not let a renderer status message bypass the voice consent state machine', () => {
    const { workspace, controller } = loadWorkspace()
    controller.reportVoiceStatus('active')
    expect(workspace.getSnapshot()).toMatchObject({ voiceConsent: false, voicePacing: false, voiceStatus: 'off' })
  })
})
