import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWorkspace } from '../domain/workspace.js'
import { AppController } from './controller.js'
import { DocumentImportService } from '../documents/import-service.js'
import { parseDocumentBytes } from '../parser/parser-core.js'

// Script corpus: unmodified repository README/SECURITY, imported through the real parser.
async function loadWorkspace(path = resolve('README.md')) {
  const workspace = createWorkspace()
  const importer = new DocumentImportService({
    parse: (format, bytes, maxOutputChars) => parseDocumentBytes(format, bytes, { maxOutputChars }),
  })
  const document = workspace.addDocument(await importer.loadPath(path))
  return { workspace, document, controller: new AppController(workspace) }
}

describe('application controller playback sessions with real documents', () => {
  it('refuses play without a document', () => {
    expect(new AppController(createWorkspace()).play()).toEqual({ ok: false, reason: 'no-document' })
  })

  it('rejects stale document, revision, and session checkpoints', async () => {
    const { workspace, document, controller } = await loadWorkspace()
    controller.play()
    const oldSession = workspace.getSnapshot().playbackSessionId!
    controller.pause()
    controller.play()
    const currentSession = workspace.getSnapshot().playbackSessionId!
    const other = (await loadWorkspace(resolve('SECURITY.md'))).document
    const checkpoint = { documentId: document.id, revision: document.revision, sessionId: currentSession,
      seekGeneration: workspace.getSnapshot().seekGeneration, position: 0.5, terminal: false }
    expect(controller.checkpoint({ ...checkpoint, documentId: other.id })).toEqual({ ok: false, reason: 'stale' })
    expect(controller.checkpoint({ ...checkpoint, revision: document.revision - 1 })).toEqual({ ok: false, reason: 'stale' })
    expect(controller.checkpoint({ ...checkpoint, sessionId: oldSession })).toEqual({ ok: false, reason: 'stale' })
    expect(workspace.getSnapshot().scrollPosition).toBe(0)
  })

  it('accepts the active session, pauses deterministically, and completes at the end', async () => {
    const { workspace, document, controller } = await loadWorkspace()
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

  it('rejects delayed pre-seek progress and terminal checkpoints without restarting the countdown session', async () => {
    const { workspace, document, controller } = await loadWorkspace()
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

})
