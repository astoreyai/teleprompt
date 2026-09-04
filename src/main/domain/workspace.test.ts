import { readFileSync, statSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWorkspace } from './workspace.js'

// Provenance: repository Markdown source files, without generated content.
const readmePath = resolve('README.md')
const securityPath = resolve('SECURITY.md')
const readme = readFileSync(readmePath, 'utf8')
const security = readFileSync(securityPath, 'utf8')

describe('document workspace', () => {
  it('uses stable IDs so a delayed edit can never target a neighboring document', () => {
    const workspace = createWorkspace()
    const first = workspace.addDocument({
      name: basename(readmePath), sourcePath: null, format: 'markdown',
      content: readme, sourceMtimeMs: null,
    })
    const second = workspace.addDocument({
      name: basename(securityPath), sourcePath: null, format: 'markdown',
      content: security, sourceMtimeMs: null,
    })
    workspace.removeDocument(first.id)
    expect(workspace.updateDocument({ id: first.id, expectedRevision: first.revision, content: security }))
      .toEqual({ ok: false, reason: 'not-found' })
    expect(workspace.getDocument(second.id)?.content).toBe(security)
  })

  it('rejects stale concurrent edits and exposes content separately from snapshots', () => {
    const workspace = createWorkspace()
    const document = workspace.addDocument({
      name: basename(readmePath), sourcePath: readmePath, format: 'markdown',
      content: readme, sourceMtimeMs: statSync(readmePath).mtimeMs,
    })
    expect(workspace.updateDocument({ id: document.id, expectedRevision: document.revision, content: security }))
      .toEqual({ ok: true, revision: document.revision + 1 })
    expect(workspace.updateDocument({ id: document.id, expectedRevision: document.revision, content: readme }))
      .toEqual({ ok: false, reason: 'conflict', currentRevision: document.revision + 1 })
    expect(workspace.getSnapshot().documents.every((meta) => !('content' in meta))).toBe(true)
    expect(workspace.getActiveDocument()).toMatchObject({ id: document.id, revision: document.revision + 1, content: security })
  })

  it('cannot enter playing state without an active document', () => {
    expect(createWorkspace().patchState({ playing: true }).playing).toBe(false)
  })
})
