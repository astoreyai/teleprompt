import { describe, expect, it } from 'vitest'
import { createWorkspace } from './workspace.js'

describe('document workspace', () => {
  it('uses stable IDs so a delayed edit can never target a neighboring document', () => {
    const workspace = createWorkspace()
    const first = workspace.addDocument({
      name: 'first.md',
      sourcePath: null,
      format: 'markdown',
      content: 'first',
      sourceMtimeMs: null,
    })
    const second = workspace.addDocument({
      name: 'second.md',
      sourcePath: null,
      format: 'markdown',
      content: 'second',
      sourceMtimeMs: null,
    })

    workspace.removeDocument(first.id)
    const late = workspace.updateDocument({
      id: first.id,
      expectedRevision: first.revision,
      content: 'late first edit',
    })

    expect(late).toEqual({ ok: false, reason: 'not-found' })
    expect(workspace.getDocument(second.id)?.content).toBe('second')
  })

  it('rejects stale concurrent edits and exposes content separately from snapshots', () => {
    const workspace = createWorkspace()
    const document = workspace.addDocument({
      name: 'talk.txt',
      sourcePath: '/tmp/talk.txt',
      format: 'text',
      content: 'original',
      sourceMtimeMs: 100,
    })

    expect(
      workspace.updateDocument({
        id: document.id,
        expectedRevision: document.revision,
        content: 'new copy',
      }),
    ).toEqual({ ok: true, revision: document.revision + 1 })
    expect(
      workspace.updateDocument({
        id: document.id,
        expectedRevision: document.revision,
        content: 'stale copy',
      }),
    ).toEqual({ ok: false, reason: 'conflict', currentRevision: document.revision + 1 })

    const snapshotJson = JSON.stringify(workspace.getSnapshot())
    expect(snapshotJson).not.toContain('new copy')
    expect(workspace.getActiveDocument()).toMatchObject({
      id: document.id,
      revision: document.revision + 1,
      content: 'new copy',
    })
  })

  it('cannot enter playing state without an active document', () => {
    const workspace = createWorkspace()
    expect(workspace.patchState({ playing: true }).playing).toBe(false)
  })
})
