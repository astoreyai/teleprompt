import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { purgeOldCrashArtifacts } from './crash-retention.js'

// The worker performs real Linux renameat2 exchanges, not mocked filesystem calls.
// Both directories contain disposable copies of the actual repository README.
it.each(['root', 'nested'] as const)('preserves external content during concurrent %s directory replacement', async location => {
  const base = await mkdtemp(join(tmpdir(), 'teleprompt-crash-race-'))
  const crashpad = join(base, 'Crashpad')
  const target = location === 'root' ? crashpad : join(crashpad, 'pending')
  const external = join(base, 'external')
  const alternate = join(base, 'alternate')
  await mkdir(target, { recursive: true })
  await mkdir(external)
  await copyFile('README.md', join(target, 'README.txt'))
  await copyFile('README.md', join(external, 'README.txt'))
  await symlink(external, alternate)
  const worker = spawn('python3', [resolve('test/native-directory-exchange.py'), target, alternate], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let errors = ''
  worker.stdout.on('data', bytes => { output += bytes.toString() })
  worker.stderr.on('data', bytes => { errors += bytes.toString() })
  const exited = once(worker, 'exit')
  try {
    await once(worker.stdout, 'data')
    let passes = 0
    while (worker.exitCode === null) {
      await purgeOldCrashArtifacts(crashpad, { maxArtifacts: 0 })
      passes += 1
    }
    await exited
    expect(errors).toBe('')
    expect(worker.exitCode).toBe(0)
    expect(Number(output.trim().split('\n').at(-1))).toBeGreaterThan(0)
    expect(passes).toBeGreaterThan(0)
    expect(await readFile(join(external, 'README.txt'))).toEqual(await readFile('README.md'))
  } finally {
    if (worker.exitCode === null) worker.kill('SIGKILL')
    await exited
    await rm(base, { recursive: true, force: true })
  }
}, 10000)
