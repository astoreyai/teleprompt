import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { purgeOldCrashArtifacts } from './crash-retention.js'

const directories: string[] = []
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'teleprompt-retention-real-'))
  directories.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

// These are actual measurement reports, not manufactured crash dumps. They test
// whether cleanup can escape into unrelated real JSON documents through a link.
async function reports(target: string) {
  await mkdir(target)
  const source = resolve('docs/audits/2026-09-04/evidence/performance')
  const inputs = (await readdir(source)).filter(name => name.endsWith('.json')).map(name => join(source, name))
  inputs.push(resolve('package.json'), resolve('package-lock.json'))
  expect(inputs.length).toBeGreaterThan(10)
  const originals = new Map<string, Buffer>()
  for (const input of inputs) {
    const name = basename(input)
    await copyFile(input, join(target, name))
    originals.set(name, await readFile(input))
  }
  return originals
}

async function expectPreserved(target: string, originals: Map<string, Buffer>) {
  expect((await readdir(target)).sort()).toEqual([...originals.keys()].sort())
  for (const [name, bytes] of originals) {
    expect((await readFile(join(target, name))).equals(bytes), name).toBe(true)
  }
}

describe('crash cleanup confinement using actual reports', () => {
  it('does not follow a symlink supplied as the cleanup root', async () => {
    const root = await directory()
    const external = join(root, 'reports')
    const originals = await reports(external)
    const link = join(root, 'Crashpad')
    await symlink(external, link)
    await purgeOldCrashArtifacts(link)
    await expectPreserved(external, originals)
  })

  it('does not follow a nested directory symlink', async () => {
    const root = await directory()
    const external = join(root, 'reports')
    const originals = await reports(external)
    const crashpad = join(root, 'Crashpad')
    await mkdir(crashpad)
    await symlink(external, join(crashpad, 'pending'))
    await purgeOldCrashArtifacts(crashpad)
    await expectPreserved(external, originals)
  })

  it('keeps the configured count of eligible real reports inside an ordinary directory', async () => {
    const root = join(await directory(), 'reports')
    const originals = await reports(root)
    await copyFile(resolve('build/icon.png'), join(root, 'icon.png'))
    await purgeOldCrashArtifacts(root)
    const kept = await readdir(root)
    expect(kept.filter(name => name.endsWith('.json'))).toHaveLength(10)
    expect((await readFile(join(root, 'icon.png'))).equals(await readFile(resolve('build/icon.png')))).toBe(true)
    for (const name of kept.filter(name => name.endsWith('.json'))) {
      expect((await readFile(join(root, name))).equals(originals.get(name)!), name).toBe(true)
    }
  })

  it('tolerates a missing cleanup root', async () => {
    await expect(purgeOldCrashArtifacts(join(await directory(), 'Crashpad'))).resolves.toBeUndefined()
  })
})
