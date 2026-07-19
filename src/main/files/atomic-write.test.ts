import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { saveTextAtomically } from './atomic-write.js'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('atomic text writes', () => {
  it('replaces a file and leaves no temporary sibling behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'teleprompt-write-'))
    created.push(dir)
    const targetPath = join(dir, 'talk.txt')
    await writeFile(targetPath, 'old', 'utf8')
    const before = await stat(targetPath)

    const result = await saveTextAtomically({
      targetPath,
      content: 'new',
      expectedMtimeMs: before.mtimeMs,
    })

    expect(result.ok).toBe(true)
    expect(await readFile(targetPath, 'utf8')).toBe('new')
    expect(await readdir(dir)).toEqual(['talk.txt'])
  })

  it('refuses to overwrite a source changed outside the app', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'teleprompt-write-'))
    created.push(dir)
    const targetPath = join(dir, 'talk.txt')
    await writeFile(targetPath, 'external', 'utf8')

    const result = await saveTextAtomically({
      targetPath,
      content: 'local',
      expectedMtimeMs: 1,
    })

    expect(result).toMatchObject({ ok: false, reason: 'conflict' })
    expect(await readFile(targetPath, 'utf8')).toBe('external')
  })
})
