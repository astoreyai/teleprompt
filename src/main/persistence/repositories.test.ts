import { copyFile, mkdtemp, readFile, readdir, stat, symlink, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDefaultSnapshot } from '../../shared/defaults.js'
import { DraftRepository, MetadataRepository } from './repositories.js'
import { persistedFromSnapshot } from './schema.js'

// Provenance: draft bytes from repository Markdown; damaged metadata is the actual
// repository output truncated by the filesystem, never an authored fake JSON fixture.
const readmePath = resolve('README.md')
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

describe('draft repository', () => {
  it('round-trips bounded drafts in a private directory', async () => {
    const directory = await tempDirectory()
    const content = await readFile(readmePath, 'utf8')
    const repository = new DraftRepository(join(directory, 'drafts'), Buffer.byteLength(content))
    await repository.write('README.md', content)
    expect(await repository.read('README.md')).toBe(content)
    expect((await stat(join(directory, 'drafts'))).mode & 0o077).toBe(0)
    await repository.delete('README.md')
    expect(await repository.read('README.md')).toBeNull()
  })

  it('rejects traversal, oversized content, and symbolic-link drafts', async () => {
    const directory = await tempDirectory()
    const content = await readFile(readmePath, 'utf8')
    const draftDirectory = join(directory, 'drafts')
    const repository = new DraftRepository(draftDirectory, Buffer.byteLength(content) - 1)
    await expect(repository.write('../README.md', content)).rejects.toThrow('invalid document id')
    await expect(repository.write('README.md', content)).rejects.toThrow('draft too large')
    await repository.initialize()
    const outside = join(directory, 'README.md')
    await copyFile(readmePath, outside)
    await symlink(outside, join(draftDirectory, 'linked.txt'))
    await expect(repository.read('linked')).rejects.toThrow('symbolic link')
  })
})
