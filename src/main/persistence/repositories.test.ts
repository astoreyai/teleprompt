import { mkdtemp, readFile, readdir, stat, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDefaultSnapshot } from '../../shared/defaults.js'
import { MetadataRepository } from './repositories.js'
import { persistedFromSnapshot } from './schema.js'

// Damaged metadata is actual repository output truncated by the filesystem,
// never an authored fake JSON fixture.
async function tempDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'teleprompt-state-real-'))
}

describe('metadata repository', () => {
  it('quarantines malformed JSON and starts from safe defaults', async () => {
    const directory = await tempDirectory()
    const repository = new MetadataRepository({ directory, fileName: 'state.json' })
    await repository.save(persistedFromSnapshot(createDefaultSnapshot()))
    await truncate(repository.path, (await stat(repository.path)).size - 2)
    const loaded = await repository.load()
    expect(loaded.parsed.quarantined).toBe(true)
    expect(loaded.parsed.value.state.opacity).toBe(createDefaultSnapshot().opacity)
    expect((await readdir(directory)).some((name) => name.startsWith('state.quarantine-'))).toBe(true)
  })

  it('atomically saves private metadata and retains one valid backup', async () => {
    const directory = await tempDirectory()
    const repository = new MetadataRepository({ directory, fileName: 'state.json' })
    const first = persistedFromSnapshot(createDefaultSnapshot())
    await repository.save(first)
    const second = structuredClone(first)
    second.state.opacity /= 2
    await repository.save(second)
    expect(JSON.parse(await readFile(repository.path, 'utf8')).state.opacity).toBe(second.state.opacity)
    expect(JSON.parse(await readFile(`${repository.path}.bak`, 'utf8')).state.opacity).toBe(first.state.opacity)
    expect((await stat(repository.path)).mode & 0o077).toBe(0)
  })

  it('recovers the last valid backup when the primary state is corrupted', async () => {
    const directory = await tempDirectory()
    const repository = new MetadataRepository({ directory, fileName: 'state.json' })
    const first = persistedFromSnapshot(createDefaultSnapshot())
    await repository.save(first)
    const second = structuredClone(first)
    second.state.opacity /= 2
    await repository.save(second)
    await truncate(repository.path, (await stat(repository.path)).size - 2)
    const recovered = await repository.load()
    expect(recovered.source).toBe('backup')
    expect(recovered.parsed.value.state.opacity).toBe(first.state.opacity)
    expect(recovered.parsed.issues).toContain('recovered state from backup')
  })
})
