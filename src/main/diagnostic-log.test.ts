import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendDiagnosticLine } from './diagnostic-log.js'

const directories: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('appendDiagnosticLine', () => {
  it('redacts credentials and rotates a bounded log', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teleprompt-log-'))
    directories.push(directory)
    const path = join(directory, 'crash.log')
    await writeFile(path, 'x'.repeat(90))
    appendDiagnosticLine(path, 'token=super-secret failure', { maxBytes: 100 })
    expect(await readFile(`${path}.1`, 'utf8')).toHaveLength(90)
    const current = await readFile(path, 'utf8')
    expect(current).toContain('token=[REDACTED]')
    expect(current).not.toContain('super-secret')
  })

  it('refuses to follow a symbolic-link destination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teleprompt-log-'))
    directories.push(directory)
    const target = join(directory, 'target')
    const path = join(directory, 'crash.log')
    await writeFile(target, 'original')
    await symlink(target, path)
    appendDiagnosticLine(path, 'should not land')
    expect(await readFile(target, 'utf8')).toBe('original')
  })
})
