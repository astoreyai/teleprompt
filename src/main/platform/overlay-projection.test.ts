import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWorkspace } from '../domain/workspace.js'
import { DocumentImportService } from '../documents/import-service.js'
import { parseDocumentBytes } from '../parser/parser-core.js'
import { projectOverlaySnapshot } from './overlay-projection.js'

describe('overlay read model', () => {
  it('contains rendering state but no file paths, recent grants, hotkeys, or consent settings', async () => {
    const sourcePath = resolve('README.md')
    const importer = new DocumentImportService({
      parse: (format, bytes, maxOutputChars) => parseDocumentBytes(format, bytes, { maxOutputChars }),
    })
    const workspace = createWorkspace()
    const document = workspace.addDocument(await importer.loadPath(sourcePath))
    workspace.selectDocument(document.id)
    workspace.patchState({ recentFiles: [sourcePath], voiceConsent: true })
    const snapshot = workspace.getSnapshot()
    const projected = projectOverlaySnapshot(snapshot)
    expect(projected.activeDocumentMeta).toEqual({ id: document.id, format: document.format, revision: document.revision })
    expect(projected.scrollSpeed).toBe(snapshot.scrollSpeed)
    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain(sourcePath)
    expect(serialized).not.toContain('documents')
    expect(serialized).not.toContain('recentFiles')
    expect(serialized).not.toContain('hotkeyBindings')
    expect(serialized).not.toContain('voiceConsent')
  })
})
