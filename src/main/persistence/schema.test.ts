import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWorkspace } from '../domain/workspace.js'
import { DocumentImportService } from '../documents/import-service.js'
import { parseDocumentBytes } from '../parser/parser-core.js'
import { MetadataRepository } from './repositories.js'
import { parsePersistedState, persistedFromSnapshot } from './schema.js'

async function captured(directory: string, name: string) {
  const provenance = JSON.parse(await readFile(join(directory, 'provenance.json'), 'utf8'))
  const entry = provenance.artifacts.find((artifact: { name: string }) => artifact.name === name)
  if (!entry) throw new Error('Captured artifact is missing from provenance')
  const bytes = await readFile(join(directory, name))
  expect(bytes.length).toBe(entry.bytes)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256)
  return JSON.parse(bytes.toString('utf8'))
}

// These files are unmodified output from actual official 0.1.0 and installed1.0.3
// applications operated with public repository documents in isolated profiles.
// Unsafe legacy-value normalization and future-version rejection still lack
// authentic incident inputs; no fabricated settings stand in for those branches.
describe('persistence schema from actual application output', () => {
  it('starts clean when the filesystem has no state files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teleprompt-schema-absence-'))
    try {
      const loaded = await new MetadataRepository({ directory }).load()
      expect(loaded).toMatchObject({ source: 'default', parsed: { migrated: false, quarantined: false, issues: [] } })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('migrates the original0.1.0 emitted flatstate and removes obsolete runtime settings', async () => {
    const path = resolve('test/fixtures/public/legacy-0.1.0')
    const raw = await captured(path, 'teleprompt-state.json')
    expect(raw).not.toHaveProperty('version')
    const parsed = parsePersistedState(raw)
    expect(parsed.migrated).toBe(true)
    expect(parsed.quarantined).toBe(false)
    expect(parsed.value.version).toBe(2)
    expect(parsed.value.documentRefs.map(document => document.sourcePath)).toEqual(raw.filePaths)
    expect(parsed.value.activeDocumentId).toBe(parsed.value.documentRefs[raw.currentFileIndex].id)
    for (const key of ['playing', 'editMode', 'voicePacing', 'voiceConsent', 'clickerMode', 'drivePresentation']) {
      expect(parsed.value.state).not.toHaveProperty(key)
    }
    expect(parsed.value.state.fontSize).toBe(raw.fontSize)
    expect(parsed.value.state.controlsBounds).toEqual(raw.controlsBounds)
  })

  it('retains real1.0.3 recovered document references while dropping removed voice preferences', async () => {
    const raw = await captured(resolve('test/fixtures/public/legacy-1.0.3'), 'teleprompt-state.v2.json')
    expect(raw.state).toHaveProperty('voiceConsent')
    const parsed = parsePersistedState(raw)
    expect(parsed).toMatchObject({ migrated: false, quarantined: false })
    expect(parsed.value.documentRefs).toEqual(raw.documentRefs)
    expect(parsed.value.documentRefs.some(document => document.dirty)).toBe(true)
    expect(parsed.value.state).not.toHaveProperty('voiceConsent')
    expect(parsed.value.state).not.toHaveProperty('voicePacing')
  })

  it('persists a genuine imported document by reference and excludes active playback modes', async () => {
    const importer = new DocumentImportService({
      parse: (format, bytes, maxOutputChars) => parseDocumentBytes(format, bytes, { maxOutputChars }),
    })
    const directory = await mkdtemp(join(tmpdir(), 'teleprompt-schema-current-'))
    try {
      const workspace = createWorkspace()
      const document = workspace.addDocument(await importer.loadPath(resolve('test/fixtures/public/dwi-privacy-notice.docx')))
      const snapshot = workspace.patchState({ playing: true, clickerMode: true, drivePresentation: true })
      const persisted = persistedFromSnapshot(snapshot)
      const repository = new MetadataRepository({ directory })
      await repository.save(persisted)
      const raw = JSON.parse(await readFile(repository.path, 'utf8'))
      expect(raw.documentRefs).toHaveLength(1)
      expect(raw.documentRefs[0]).toMatchObject({ id: document.id, dirty: false })
      expect(raw.documentRefs[0]).not.toHaveProperty('content')
      expect(raw.documentRefs[0]).not.toHaveProperty('saveMode')
      for (const key of ['playing', 'clickerMode', 'drivePresentation']) expect(raw.state).not.toHaveProperty(key)
      expect((await repository.load()).parsed.value).toEqual(persisted)
    } finally {
      importer.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
