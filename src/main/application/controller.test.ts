import { describe, expect, it } from 'vitest'
import { createWorkspace } from '../domain/workspace.js'
import { AppController } from './controller.js'

describe('application controller playback sessions', () => {
  it('refuses play without a document', () => {
    const controller = new AppController(createWorkspace(), () => 'session-1')
    expect(controller.play()).toEqual({ ok: false, reason: 'no-document' })
  })

  it('rejects stale document, revision, and session checkpoints', () => {
    const workspace = createWorkspace({ idFactory: () => 'document-1' })
    const document = workspace.addDocument({
      name: 'talk.txt',
      sourcePath: null,
      format: 'text',
      content: 'talk',
      sourceMtimeMs: null,
      sourceHash: null,
    })
    const controller = new AppController(workspace, () => 'session-1')
    expect(controller.play()).toMatchObject({ ok: true, sessionId: 'session-1' })

    expect(
      controller.checkpoint({
        documentId: 'wrong',
        revision: document.revision,
        sessionId: 'session-1',
        position: 0.5,
        terminal: false,
      }),
    ).toEqual({ ok: false, reason: 'stale' })
    expect(
      controller.checkpoint({
        documentId: document.id,
        revision: 99,
        sessionId: 'session-1',
        position: 0.5,
        terminal: false,
      }),
    ).toEqual({ ok: false, reason: 'stale' })
    expect(
      controller.checkpoint({
        documentId: document.id,
        revision: document.revision,
        sessionId: 'old-session',
        position: 0.5,
        terminal: false,
      }),
    ).toEqual({ ok: false, reason: 'stale' })
    expect(workspace.getSnapshot().scrollPosition).toBe(0)
  })

  it('accepts the active session, pauses deterministically, and completes at the end', () => {
    const workspace = createWorkspace({ idFactory: () => 'document-1' })
    const document = workspace.addDocument({
      name: 'talk.txt',
      sourcePath: null,
      format: 'text',
      content: 'talk',
      sourceMtimeMs: null,
      sourceHash: null,
    })
    let session = 0
    const controller = new AppController(workspace, () => `session-${++session}`)
    const started = controller.play()
    expect(started).toMatchObject({ ok: true, sessionId: 'session-1' })
    expect(
      controller.checkpoint({
        documentId: document.id,
        revision: document.revision,
        sessionId: 'session-1',
        position: 0.4,
        terminal: false,
      }),
    ).toEqual({ ok: true })
    expect(workspace.getSnapshot().scrollPosition).toBe(0.4)

    controller.pause()
    expect(workspace.getSnapshot()).toMatchObject({ playing: false, playbackSessionId: null })
    const restarted = controller.play()
    expect(restarted).toMatchObject({ ok: true, sessionId: 'session-2' })
    expect(
      controller.checkpoint({
        documentId: document.id,
        revision: document.revision,
        sessionId: 'session-2',
        position: 1,
        terminal: true,
      }),
    ).toEqual({ ok: true })
    expect(workspace.getSnapshot()).toMatchObject({
      playing: false,
      playbackSessionId: null,
      scrollPosition: 1,
    })
  })

  it('revokes microphone consent and stops an active voice session', () => {
    const workspace = createWorkspace({ idFactory: () => 'document-1' })
    workspace.addDocument({
      name: 'talk.txt',
      sourcePath: null,
      format: 'text',
      content: 'talk',
      sourceMtimeMs: null,
      sourceHash: null,
    })
    const controller = new AppController(workspace)

    controller.grantVoiceConsent()
    expect(controller.requestVoice(true)).toEqual({ ok: true })
    expect(workspace.getSnapshot()).toMatchObject({
      voiceConsent: true,
      voicePacing: true,
      voiceStatus: 'starting',
    })

    controller.revokeVoiceConsent()
    expect(workspace.getSnapshot()).toMatchObject({
      voiceConsent: false,
      voicePacing: false,
      voiceStatus: 'off',
      voiceError: null,
    })
  })

  it('refuses memory-heavy voice tokenization for an oversized script', () => {
    const workspace = createWorkspace()
    workspace.addDocument({
      name: 'huge.txt',
      sourcePath: null,
      format: 'text',
      content: 'x'.repeat(500_001),
      sourceMtimeMs: null,
      sourceHash: null,
    })
    const controller = new AppController(workspace)
    controller.grantVoiceConsent()

    expect(controller.requestVoice(true)).toEqual({
      ok: false,
      reason: 'document-too-large',
    })
    expect(workspace.getSnapshot().voicePacing).toBe(false)
  })

  it('does not let a renderer status message bypass the voice consent state machine', () => {
    const workspace = createWorkspace()
    workspace.addDocument({
      name: 'talk.txt',
      sourcePath: null,
      format: 'text',
      content: 'talk',
      sourceMtimeMs: null,
      sourceHash: null,
    })
    const controller = new AppController(workspace)

    controller.reportVoiceStatus('active')
    expect(workspace.getSnapshot()).toMatchObject({
      voiceConsent: false,
      voicePacing: false,
      voiceStatus: 'off',
    })
  })
})
