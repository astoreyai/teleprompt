import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readBoundedRegularFile } from './safe-reader.js'

const readme = await readFile('README.md')
const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('bounded file reader', () => {
  it('returns bounded bytes and source metadata for a regular file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teleprompt-read-'))
    created.push(directory)
    const path = join(directory, 'talk.txt')
    await writeFile(path, readme)
    const result = await readBoundedRegularFile(path, readme.length)
    expect(result.bytes.toString('utf8')).toBe(readme.toString('utf8'))
    expect(result.size).toBe(readme.length)
    expect(result.mtimeMs).toBeGreaterThan(0)
  })

  it('rejects symbolic links and oversized files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teleprompt-read-'))
    created.push(directory)
    const target = join(directory, 'target.txt')
    const link = join(directory, 'link.txt')
    await writeFile(target, readme)
    await symlink(target, link)
    await expect(readBoundedRegularFile(link, readme.length)).rejects.toThrow(/symbolic link|ELOOP/)
    await expect(readBoundedRegularFile(target, readme.length - 1)).rejects.toThrow('file too large')
  })
})
