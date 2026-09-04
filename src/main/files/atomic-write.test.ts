import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { saveTextAtomically } from './atomic-write.js'

const readme = await readFile('README.md', 'utf8')
const security = await readFile('SECURITY.md', 'utf8')
const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('atomic text writes', () => {
  it('replaces a file and leaves no temporary sibling behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'teleprompt-write-'))
    created.push(dir)
    const targetPath = join(dir, 'talk.txt')
    await writeFile(targetPath, readme, 'utf8')
    const before = await stat(targetPath)

    const result = await saveTextAtomically({
      targetPath,
      content: security,
      expectedMtimeMs: before.mtimeMs,
    })

    expect(result.ok).toBe(true)
    expect(await readFile(targetPath, 'utf8')).toBe(security)
    expect(await readdir(dir)).toEqual(['talk.txt'])
  })

  it('refuses to overwrite a source changed outside the app', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'teleprompt-write-'))
    created.push(dir)
    const targetPath = join(dir, 'talk.txt')
    await writeFile(targetPath, readme, 'utf8')

    const result = await saveTextAtomically({
      targetPath,
      content: security,
      expectedMtimeMs: 1,
    })

    expect(result).toMatchObject({ ok: false, reason: 'conflict' })
    expect(await readFile(targetPath, 'utf8')).toBe(readme)
  })
})

// The source identity is read from real bytes; the changed target retains its actual mtime.
it('refuses changed source bytes even when the caller supplies its current mtime', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teleprompt-write-hash-'))
  created.push(dir)
  const targetPath = join(dir, 'README.txt')
  await writeFile(targetPath, security)
  const before = await stat(targetPath)
  const result = await saveTextAtomically({ targetPath, content: readme,
    expectedMtimeMs: before.mtimeMs,
    expectedSourceHash: createHash('sha256').update(readme).digest('hex'),
  })
  expect(result).toMatchObject({ ok: false, reason: 'conflict' })
  expect(await readFile(targetPath, 'utf8')).toBe(security)
  expect(await readdir(dir)).toEqual(['README.txt'])
})
