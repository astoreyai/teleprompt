import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendDiagnosticLine } from './diagnostic-log.js'

// Verbatim public CI output; GitHub masked the real credential before publication.
// Source URL, capture time, and checksum accompany this fixture.
const message = await readFile(resolve('test/fixtures/github-checkout-token.log'), 'utf8')
const directories: string[] = []
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'teleprompt-log-real-'))
  directories.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('diagnostics with actual CI output and filesystem objects', () => {
  it('redacts the recorded credential field and rotates the actual preceding log', async () => {
    const path = join(await directory(), 'crash.log')
    appendDiagnosticLine(path, message)
    const previous = await readFile(path)
    appendDiagnosticLine(path, message, { maxBytes: previous.length })
    expect(await readFile(`${path}.1`)).toEqual(previous)
    const current = await readFile(path, 'utf8')
    expect(current).toContain('token=[REDACTED]')
    expect(current).not.toContain('token: ***')
    expect(current.trim().split('\n')).toHaveLength(1)
    expect(Buffer.byteLength(current)).toBeLessThanOrEqual(previous.length)
  })

  it('preserves the real document behind a symlink destination', async () => {
    const root = await directory()
    const target = join(root, 'README.md')
    await copyFile(resolve('README.md'), target)
    const original = await readFile(target)
    const path = join(root, 'crash.log')
    await symlink(target, path)
    appendDiagnosticLine(path, message)
    expect(await readFile(target)).toEqual(original)
  })

  it('replaces a backup symlink without modifying its real document target', async () => {
    const root = await directory()
    const target = join(root, 'SECURITY.md')
    await copyFile(resolve('SECURITY.md'), target)
    const original = await readFile(target)
    const path = join(root, 'crash.log')
    appendDiagnosticLine(path, message)
    const previous = await readFile(path)
    await symlink(target, `${path}.1`)
    appendDiagnosticLine(path, message, { maxBytes: previous.length })
    expect(await readFile(target)).toEqual(original)
    expect(await readFile(`${path}.1`)).toEqual(previous)
  })

  it('creates private diagnostic files and directories', async () => {
    const parent = join(await directory(), 'logs')
    const path = join(parent, 'crash.log')
    appendDiagnosticLine(path, message)
    expect((await stat(parent)).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('tolerates an actual directory at the destination', async () => {
    const path = join(await directory(), 'crash.log')
    await mkdir(path)
    expect(() => appendDiagnosticLine(path, message)).not.toThrow()
    expect((await stat(path)).isDirectory()).toBe(true)
  })
})
