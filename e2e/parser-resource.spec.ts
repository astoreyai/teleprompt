import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'

// This probe runs the real production supervisor, adapter, and worker inside
// Electron. SIGSTOP exercises an actual kernel suspension, never a fake worker.
for (const scenario of [
  { mode: 'timeout', format: 'pdf' },
  { mode: 'cancel', format: 'pdf' },
  { mode: 'success', format: 'pdf' },
  { mode: 'success', format: 'docx' },
  { mode: 'memory', format: 'pdf' },
  { mode: 'crash', format: 'pdf' },
  { mode: 'output', format: 'pdf' },
] as const) {
test(`parser ${scenario.format} ${scenario.mode} waits for its real utility process to exit`, async () => {
  const source = process.env[scenario.format === 'pdf' ? 'TELEPROMPT_REAL_PDF' : 'TELEPROMPT_REAL_DOCX']
  if (!source) throw new Error(`A genuine ${scenario.format} document is required`)
  await mkdir(resolve('.release-local'), { recursive: true })
  const directory = await mkdtemp(resolve('.release-local/parser-resource-'))
  try {
    const worker = join(directory, 'worker.mjs')
    await build({ entryPoints: ['src/main/parser/worker.ts'], outfile: worker,
      bundle: true, platform: 'node', format: 'esm', packages: 'external' })
    const runner = join(directory, 'probe.cjs')
    await build({ stdin: { resolveDir: process.cwd(), contents: `
      import { app } from 'electron'
      import { readFile, access } from 'node:fs/promises'
      import { ParserSupervisor } from './src/main/parser/supervisor.ts'
      import { spawnElectronParser } from './src/main/parser/electron-adapter.ts'
      ;(async () => {
        const phase = (name, details = {}) => console.log('PARSER_PHASE ' + JSON.stringify({ name, at: Date.now(), ...details }))
        phase('before-ready', { pid: process.pid })
        await app.whenReady()
        phase('ready')
        const bytes = await readFile(${JSON.stringify(source)})
        phase('source-read', { bytes: bytes.length })
        const mode = ${JSON.stringify(scenario.mode)}
        const controller = new AbortController()
        let baselinePeakRssKiB = 0
        let maxRssBytes
        let maxOutputChars = 10 * 1024 * 1024
        if (mode === 'memory' || mode === 'output') {
          // Calibrate against this genuine document in the actual native worker.
          // Then lower policy, never fabricate an allocation to trigger it.
          const baselineMonitor = setInterval(() => {
            const metric = app.getAppMetrics().find(item => item.name === 'Teleprompt document parser')
            if (metric) baselinePeakRssKiB = Math.max(baselinePeakRssKiB, metric.memory.workingSetSize)
          }, 1)
          try {
            const content = await new ParserSupervisor(() => spawnElectronParser(${JSON.stringify(worker)}))
              .parse(${JSON.stringify(scenario.format)}, bytes, 10 * 1024 * 1024)
            if (mode === 'output') maxOutputChars = content.length - 1
          } finally { clearInterval(baselineMonitor) }
          if (!baselinePeakRssKiB) throw new Error('No actual parser RSS observation')
          if (mode === 'memory') maxRssBytes = Math.floor(baselinePeakRssKiB * 1024 / 2)
        }
        let pid
        let stopped = false
        let killed = false
        let peakRssKiB = 0
        const monitor = setInterval(() => {
          const metric = app.getAppMetrics().find(item => item.name === 'Teleprompt document parser')
          if (!metric) return
          peakRssKiB = Math.max(peakRssKiB, metric.memory.workingSetSize)
          if (pid === undefined) phase('worker-observed', { pid: metric.pid })
          pid = metric.pid
          if (mode === 'crash' && !killed) {
            process.kill(pid, 'SIGKILL')
            killed = true
            phase('worker-killed', { pid })
          }
          if ((mode === 'timeout' || mode === 'cancel') && !stopped) {
            process.kill(pid, 'SIGSTOP')
            stopped = true
            phase('worker-stopped', { pid })
            if (mode === 'cancel') controller.abort()
          }
        }, 1)
        let error = ''
        let contentLength = 0
        try {
          phase('parse-start')
          const content = await new ParserSupervisor(() => spawnElectronParser(${JSON.stringify(worker)}, { maxRssBytes }),
            { timeoutMs: mode === 'timeout' ? 500 : 10_000 }).parse(${JSON.stringify(scenario.format)}, bytes, maxOutputChars, controller.signal)
          contentLength = content.length
        } catch (failure) { error = String(failure) }
        phase('parse-settled', { error })
        clearInterval(monitor)
        let exists = false
        if (pid) {
          try { await access('/proc/' + pid); exists = true } catch {}
          if (exists) process.kill(pid, 'SIGKILL')
        }
        console.log('PARSER_PROBE ' + JSON.stringify({ stopped, killed, error, contentLength, baselinePeakRssKiB, maxRssBytes, maxOutputChars,
          exitedBeforeSettlement: !!pid && !exists, peakRssKiB }))
        app.quit()
      })().catch(error => { console.error(error); app.exit(1) })
    ` }, outfile: runner, bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
    const environment: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(directory, 'profile') }
    delete environment.ELECTRON_RUN_AS_NODE
    // Electron 43 installs its development runtime lazily through this supported entrypoint.
    const electronExecutable = createRequire(import.meta.url)('electron') as string
    const child = spawn(electronExecutable, [runner],
      { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    const launchedAt = Date.now()
    let watchdogFired = false
    const timeout = setTimeout(() => {
      watchdogFired = true
      child.kill('SIGKILL')
    }, 15_000)
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
    try {
      exit = await new Promise((done, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => done({ code, signal }))
      })
    } finally {
      clearTimeout(timeout)
      await test.info().attach('native-parser-lifecycle.json', {
        body: JSON.stringify({ launchedAt, elapsedMs: Date.now() - launchedAt,
          pid: child.pid, watchdogFired, exit, output }), contentType: 'application/json',
      })
    }
    expect(exit?.code, output).toBe(0)
    const captured = output.match(/^PARSER_PROBE (.+)$/m)
    expect(captured, output).not.toBeNull()
    const result = JSON.parse(captured![1])
    await test.info().attach('native-parser-resource.json', { body: JSON.stringify(result), contentType: 'application/json' })
    if (scenario.mode === 'crash') {
      expect(result.killed).toBe(true)
      expect(result.error).toContain('parser process exited with code')
    } else if (scenario.mode === 'output') {
      expect(result.maxOutputChars).toBeGreaterThan(0)
      expect(result.error).toContain('extracted text too large')
    } else if (scenario.mode === 'memory') {
      expect(result.baselinePeakRssKiB).toBeGreaterThan(0)
      expect(result.maxRssBytes).toBe(Math.floor(result.baselinePeakRssKiB * 1024 / 2))
      expect(result.error).toContain('parser memory limit exceeded')
      expect(result.peakRssKiB * 1024).toBeGreaterThan(result.maxRssBytes)
    } else if (scenario.mode === 'success') {
      expect(result.error).toBe('')
      expect(result.contentLength).toBeGreaterThan(0)
    } else {
      expect(result.stopped).toBe(true)
      expect(result.error).toContain(scenario.mode === 'timeout' ? 'parser timed out' : 'parser cancelled')
    }
    expect(result.exitedBeforeSettlement).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
}
