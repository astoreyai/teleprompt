import { expect, test } from '@playwright/test'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { launch, readme, stop, surface } from './harness.js'

test('startup preserves real reports behind a symlinked crash directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-startup-retention-'))
  let application: Awaited<ReturnType<typeof launch>> | undefined
  try {
    const reports = join(directory, 'reports')
    const profile = join(directory, 'teleprompt')
    await mkdir(reports)
    await mkdir(profile)
    const source = resolve('docs/audits/2026-09-04/evidence/performance')
    const inputs = (await readdir(source)).filter(name => name.endsWith('.json')).map(name => join(source, name))
    inputs.push(resolve('package.json'), resolve('package-lock.json'))
    expect(inputs.length).toBeGreaterThan(10)
    const originals = new Map<string, Buffer>()
    for (const input of inputs) {
      const target = join(reports, basename(input))
      await copyFile(input, target)
      originals.set(target, await readFile(input))
    }
    const crashpad = join(profile, 'Crashpad')
    await symlink(reports, crashpad)
    expect((await lstat(crashpad)).isSymbolicLink()).toBe(true)
    application = await launch(directory, [resolve('README.md')])
    const controls = await surface(application, 'controls')
    await expect.poll(() => controls.evaluate(async () => (await window.controlsApi.bootstrap()).activeDocument?.content)).toBe(readme)
    // The real main-process startup cleanup has completed before Controls loads.
    for (const [target, bytes] of originals) expect(await readFile(target)).toEqual(bytes)
    await stop(application)
  } finally {
    if (application) {
      await stop(application).catch(() => undefined)
      if (application.process.exitCode === null && application.process.signalCode === null) application.process.kill('SIGKILL')
    }
    await rm(directory, { recursive: true, force: true })
  }
})
