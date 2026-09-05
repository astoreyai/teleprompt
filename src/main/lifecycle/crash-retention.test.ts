import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { purgeOldCrashArtifacts } from './crash-retention.js'

// Capture provenance and unmodified native Crashpad files with the packaged
// recovery-budget test. Process-memory artifacts remain in local test output.
const corpus = process.env.TELEPROMPT_REAL_CRASH_CORPUS
if (!corpus) throw new Error('Set TELEPROMPT_REAL_CRASH_CORPUS to a native recovery test crash-corpus directory')
const provenance = JSON.parse(await readFile(join(corpus, 'provenance.json'), 'utf8')) as {
  artifacts: Array<{ name: string; bytes: number; sha256: string }>
}
async function artifact(extension: '.dmp' | '.meta') {
  const entry = provenance.artifacts.find(file => file.name.endsWith(extension))
  if (!entry || basename(entry.name) !== entry.name) throw new Error(`Missing native ${extension} artifact`)
  const path = join(corpus!, entry.name)
  const bytes = await readFile(path)
  expect(bytes.length).toBe(entry.bytes)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256)
  return { path, name: entry.name, bytes }
}

const created: string[] = []
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'teleprompt-crashes-'))
  created.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(created.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('retention with genuine native Crashpad artifacts', () => {
  it('purges elapsed dumps and metadata while preserving the actual application icon', async () => {
    const root = await directory()
    const pending = join(root, 'pending')
    await mkdir(pending)
    const dump = await artifact('.dmp')
    const meta = await artifact('.meta')
    const dumpPath = join(pending, dump.name)
    const metaPath = join(pending, meta.name)
    const icon = join(pending, 'icon.png')
    await Promise.all([copyFile(dump.path, dumpPath), copyFile(meta.path, metaPath), copyFile('build/icon.png', icon)])
    // Exercise age expiry using elapsed wall time and a zero-age policy. Neither
    // source dates nor file contents are manufactured or changed.
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(Date.now()).toBeGreaterThan(Math.max((await stat(dumpPath)).mtimeMs, (await stat(metaPath)).mtimeMs))
    await purgeOldCrashArtifacts(root, { maxAgeMs: 0 })
    await expect(stat(dumpPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(metaPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(icon)).toEqual(await readFile('build/icon.png'))
  })

  it('keeps the genuinely newer artifact and tolerates a missing directory', async () => {
    const root = await directory()
    const meta = await artifact('.meta')
    const dump = await artifact('.dmp')
    const older = join(root, meta.name)
    const newer = join(root, dump.name)
    await copyFile(meta.path, older)
    await new Promise(resolve => setTimeout(resolve, 25))
    await copyFile(dump.path, newer)
    expect((await stat(newer)).mtimeMs).toBeGreaterThan((await stat(older)).mtimeMs)
    await purgeOldCrashArtifacts(root, { maxArtifacts: 1 })
    expect(await readFile(newer)).toEqual(dump.bytes)
    await expect(stat(older)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(root)).toEqual([dump.name])
    await expect(purgeOldCrashArtifacts(join(root, 'missing'))).resolves.toBeUndefined()
  })

  it('preserves fresh dump and metadata bytes under the default retention policy', async () => {
    const root = await directory()
    const dump = await artifact('.dmp')
    const meta = await artifact('.meta')
    await Promise.all([copyFile(dump.path, join(root, dump.name)), copyFile(meta.path, join(root, meta.name))])
    await purgeOldCrashArtifacts(root)
    expect(await readFile(join(root, dump.name))).toEqual(dump.bytes)
    expect(await readFile(join(root, meta.name))).toEqual(meta.bytes)
  })
})
