import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDefaultSnapshot } from '../../shared/defaults.js'
import { DraftRepository, MetadataRepository } from './repositories.js'
import { persistedFromSnapshot } from './schema.js'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function tempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'teleprompt-state-'))
  created.push(path)
  return path
}

describe('metadata repository', () => {
  it('quarantines malformed JSON and starts from safe defaults', async () => {
    const directory = await tempDirectory()
    await writeFile(join(directory, 'state.json'), '{truncated', 'utf8')
    const repository = new MetadataRepository({ directory, fileName: 'state.json' })

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
    second.state.opacity = 0.5
    await repository.save(second)

    expect(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).state.opacity).toBe(0.5)
    expect(JSON.parse(await readFile(join(directory, 'state.json.bak'), 'utf8')).state.opacity).toBe(
      first.state.opacity,
    )
    expect((await stat(join(directory, 'state.json'))).mode & 0o077).toBe(0)
  })

  it('recovers the last valid backup when the primary state is corrupted', async () => {
    const directory = await tempDirectory()
    const repository = new MetadataRepository({ directory, fileName: 'state.json' })
    const first = persistedFromSnapshot(createDefaultSnapshot())
    first.state.opacity = 0.4
    await repository.save(first)
    const second = structuredClone(first)
    second.state.opacity = 0.6
    await repository.save(second)
    await writeFile(join(directory, 'state.json'), '{broken', 'utf8')

    const recovered = await repository.load()

    expect(recovered.source).toBe('backup')
    expect(recovered.parsed.value.state.opacity).toBe(0.4)
    expect(recovered.parsed.issues).toContain('recovered state from backup')
  })
})

describe('draft repository', () => {
  it('round-trips bounded drafts in a private directory', async () => {
    const directory = await tempDirectory()
    const repository = new DraftRepository(join(directory, 'drafts'), 1024)
    await repository.write('document-1', 'recover me')
    expect(await repository.read('document-1')).toBe('recover me')
    expect((await stat(join(directory, 'drafts'))).mode & 0o077).toBe(0)
    await repository.delete('document-1')
    expect(await repository.read('document-1')).toBeNull()
  })

  it('rejects traversal, oversized content, and symbolic-link drafts', async () => {
    const directory = await tempDirectory()
    const draftDirectory = join(directory, 'drafts')
    const repository = new DraftRepository(draftDirectory, 8)
    await expect(repository.write('../escape', 'x')).rejects.toThrow('invalid document id')
    await expect(repository.write('too-large', '123456789')).rejects.toThrow('draft too large')
    await repository.initialize()
    const outside = join(directory, 'outside.txt')
    await writeFile(outside, 'secret', 'utf8')
    await symlink(outside, join(draftDirectory, 'linked.txt'))
    await expect(repository.read('linked')).rejects.toThrow('symbolic link')
    await chmod(outside, 0o600)
  })
})
