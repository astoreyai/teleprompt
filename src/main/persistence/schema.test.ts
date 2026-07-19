import { describe, expect, it } from 'vitest'
import { createDefaultSnapshot } from '../../shared/defaults.js'
import { parsePersistedState, persistedFromSnapshot } from './schema.js'

describe('persistence schema', () => {
  it('treats missing state as a clean first launch, not a legacy migration', () => {
    expect(parsePersistedState(null)).toMatchObject({
      migrated: false,
      quarantined: false,
      issues: [],
    })
  })

  it('migrates the 0.1.x flat format and clamps unsafe values', () => {
    const parsed = parsePersistedState({
      filePaths: ['/tmp/one.txt', '/tmp/two.docx'],
      currentFileIndex: 1,
      scrollPosition: 4,
      opacity: -1,
      fontSize: 99999,
      fontColor: 'url(file:///etc/passwd)',
      controlsBounds: { x: Infinity, y: -Infinity, width: 1, height: 1 },
      recentFiles: ['/tmp/one.txt', 42, ...Array(20).fill('/tmp/repeated.txt')],
      playing: true,
      editMode: true,
      clickerMode: true,
      drivePresentation: true,
    })

    expect(parsed.migrated).toBe(true)
    expect(parsed.value.version).toBe(2)
    expect(parsed.value.documentRefs).toHaveLength(2)
    expect(parsed.value.documentRefs[1]).toMatchObject({
      sourcePath: '/tmp/two.docx',
      format: 'docx',
    })
    expect(parsed.value.activeDocumentId).toBe(parsed.value.documentRefs[1].id)
    expect(parsed.value.state).toMatchObject({
      scrollPosition: 1,
      opacity: 0.05,
      fontSize: 400,
      fontColor: '#ffffff',
      controlsBounds: { x: 80, y: 80, width: 560, height: 360 },
    })
    expect(parsed.value.state).not.toHaveProperty('playing')
    expect(parsed.value.state).not.toHaveProperty('editMode')
    expect(parsed.value.state).not.toHaveProperty('voicePacing')
    expect(parsed.value.state).not.toHaveProperty('clickerMode')
    expect(parsed.value.state).not.toHaveProperty('drivePresentation')
    expect(parsed.value.state.recentFiles).toHaveLength(2)
  })

  it('rejects unsupported future versions instead of shallow-merging them', () => {
    const parsed = parsePersistedState({ version: 999, state: { opacity: 0 }, documentRefs: [] })
    expect(parsed.quarantined).toBe(true)
    expect(parsed.value.state.opacity).toBe(createDefaultSnapshot().opacity)
    expect(parsed.issues).toContain('unsupported state version 999')
  })

  it('persists metadata and drafts by reference, never document content or transient modes', () => {
    const snapshot = createDefaultSnapshot()
    snapshot.documents = [
      {
        id: 'document-1',
        name: 'talk.md',
        sourcePath: null,
        format: 'markdown',
        saveMode: 'save-as',
        revision: 4,
        dirty: true,
        sourceMtimeMs: null,
        sourceHash: null,
      },
    ]
    snapshot.activeDocumentId = 'document-1'
    snapshot.playing = true
    snapshot.editMode = true
    snapshot.voicePacing = true
    snapshot.clickerMode = true
    snapshot.drivePresentation = true

    const persisted = persistedFromSnapshot(snapshot)
    const json = JSON.stringify(persisted)
    expect(json).not.toContain('content')
    expect(json).not.toContain('playing')
    expect(json).not.toContain('editMode')
    expect(json).not.toContain('voicePacing')
    expect(json).not.toContain('clickerMode')
    expect(json).not.toContain('drivePresentation')
    expect(persisted.documentRefs[0]).toMatchObject({ id: 'document-1', dirty: true })
  })
})
