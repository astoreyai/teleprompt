import { mkdir, mkdtemp, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { purgeOldCrashArtifacts } from './crash-retention.js'

const created: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('crash artifact retention', () => {
  it('purges old Crashpad dumps and metadata sidecars while preserving unrelated files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teleprompt-crashes-'))
    created.push(directory)
    await mkdir(join(directory, 'pending'))
    const oldDump = join(directory, 'pending', 'old.dmp')
    const oldMeta = join(directory, 'pending', 'old.meta')
    const unrelated = join(directory, 'pending', 'keep.bin')
    await Promise.all([
      writeFile(oldDump, 'dump'),
      writeFile(oldMeta, 'metadata'),
      writeFile(unrelated, 'unrelated'),
    ])
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await Promise.all([utimes(oldDump, old, old), utimes(oldMeta, old, old), utimes(unrelated, old, old)])

    await purgeOldCrashArtifacts(directory, { now: Date.now(), maxAgeMs: 7 * 24 * 60 * 60 * 1000 })

    await expect(stat(oldDump)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(oldMeta)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(unrelated)).resolves.toBeDefined()
  })

  it('keeps only the newest configured number of artifacts and tolerates a missing directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teleprompt-crashes-'))
    created.push(directory)
    const newest = join(directory, 'newest.dmp')
    const older = join(directory, 'older.meta')
    await Promise.all([writeFile(newest, 'new'), writeFile(older, 'old')])
    const now = Date.now()
    await utimes(older, new Date(now - 1000), new Date(now - 1000))

    await purgeOldCrashArtifacts(directory, {
      now,
      maxAgeMs: Number.MAX_SAFE_INTEGER,
      maxArtifacts: 1,
    })

    await expect(stat(newest)).resolves.toBeDefined()
    await expect(stat(older)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      purgeOldCrashArtifacts(join(directory, 'missing')),
    ).resolves.toBeUndefined()
  })
})
