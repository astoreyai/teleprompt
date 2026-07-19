import { describe, expect, it } from 'vitest'
import { createDefaultSnapshot } from '../../shared/defaults.js'
import { projectOverlaySnapshot } from './overlay-projection.js'

describe('overlay read model', () => {
  it('contains rendering state but no file paths, recent grants, hotkeys, or consent settings', () => {
    const snapshot = createDefaultSnapshot()
    snapshot.documents = [
      {
        id: 'document-1',
        name: 'private-talk.md',
        sourcePath: '/secret/client/private-talk.md',
        format: 'markdown',
        saveMode: 'overwrite',
        revision: 3,
        dirty: true,
        sourceMtimeMs: 1,
        sourceHash: 'a'.repeat(64),
      },
    ]
    snapshot.activeDocumentId = 'document-1'
    snapshot.recentFiles = ['/secret/client/private-talk.md']
    snapshot.voiceConsent = true

    const projected = projectOverlaySnapshot(snapshot)
    expect(projected.activeDocumentMeta).toEqual({ id: 'document-1', format: 'markdown', revision: 3 })
    expect(projected.scrollSpeed).toBe(snapshot.scrollSpeed)
    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain('/secret')
    expect(serialized).not.toContain('documents')
    expect(serialized).not.toContain('recentFiles')
    expect(serialized).not.toContain('hotkeyBindings')
    expect(serialized).not.toContain('voiceConsent')
  })
})
