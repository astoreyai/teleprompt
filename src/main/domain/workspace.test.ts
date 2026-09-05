import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DocumentImportService } from '../documents/import-service.js'
import { parseDocumentBytes } from '../parser/parser-core.js'
import { createWorkspace } from './workspace.js'

const importer = new DocumentImportService({
  parse: (format, bytes, maxOutputChars) => parseDocumentBytes(format, bytes, { maxOutputChars }),
})

describe('document workspace using real imported repository documents', () => {
  it('uses stable IDs so a delayed reload cannot target a neighboring document', async () => {
    const workspace = createWorkspace()
    const readme = await importer.loadPath(resolve('README.md'))
    const security = await importer.loadPath(resolve('SECURITY.md'))
    const first = workspace.addDocument(readme)
    const second = workspace.addDocument(security)
    workspace.removeDocument(first.id)
    expect(workspace.replaceDocument(first.id, readme)).toBeNull()
    expect(workspace.getDocument(second.id)?.content).toBe(security.content)
  })

  it('increments reload revisions and exposes content separately from snapshots', async () => {
    const workspace = createWorkspace()
    const imported = await importer.loadPath(resolve('README.md'))
    const document = workspace.addDocument(imported)
    expect(workspace.replaceDocument(document.id, await importer.loadPath(imported.sourcePath)))
      .toMatchObject({ id: document.id, revision: document.revision + 1 })
    expect(workspace.getSnapshot().documents.every(meta => !('content' in meta))).toBe(true)
    expect(workspace.getActiveDocument()).toMatchObject({ id: document.id,
      revision: document.revision + 1, content: imported.content })
  })

  it('cannot enter playing state without an active document', () => {
    expect(createWorkspace().patchState({ playing: true }).playing).toBe(false)
  })
})
