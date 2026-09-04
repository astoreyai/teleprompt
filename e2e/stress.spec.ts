import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { launch, surface, stop, readme, security } from './harness.js'
import { processTreeMemory, type ProcessMemory } from './process-memory.js'

test('sustained real-document workload records latency, memory, queue pressure and durable content', async () => {
  const duration = Number(process.env.TELEPROMPT_STRESS_MS ?? 300000)
  if (!Number.isFinite(duration) || duration < 10000) throw new Error('stress duration must be at least 10000ms')
  if (!process.env.TELEPROMPT_TEST_DISPLAY || process.env.TELEPROMPT_TEST_DISPLAY !== process.env.DISPLAY) {
    throw new Error('Use npm run test:stress: native clipboard testing requires its isolated Xvfb display')
  }
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-stress-'))
  const largeSource = resolve('node_modules/typescript/lib/typescript.js')
  const editSource = resolve('node_modules/typescript/lib/typescript.d.ts')
  const content = await readFile(editSource, 'utf8')
  const largePath = join(directory, 'typescript.txt')
  const editPath = join(directory, 'declarations.txt')
  const recentPath = join(directory, 'README.txt')
  await Promise.all([copyFile(largeSource, largePath), copyFile(editSource, editPath), writeFile(recentPath, readme)])
  const inputs = await Promise.all([largeSource, editSource, resolve('README.md'), resolve('SECURITY.md')].map(async (path) => {
    const [bytes, info] = await Promise.all([readFile(path), stat(path)])
    return { name: basename(path), bytes: bytes.length, mtime: info.mtime.toISOString(), sha256: createHash('sha256').update(bytes).digest('hex') }
  }))
  const archive = join(dirname(resolve(process.env.TELEPROMPT_E2E_EXECUTABLE ?? 'release/linux-unpacked/teleprompt')), 'resources/app.asar')
  const archiveHash = createHash('sha256').update(await readFile(archive)).digest('hex')
  const application = await launch(directory, [largePath, editPath, recentPath])
  const memory: Array<{ elapsedMs: number; rssBytes: number; pssBytes: number; privateBytes: number; processes: ProcessMemory[] }> = []
  const latencyMs: number[] = []
  const pasteLatencyMs: number[] = []
  const started = Date.now()
  let sampling = true
  let sampleError: unknown
  const sampler = (async () => {
    while (sampling) {
      try {
        const processes = await processTreeMemory(application.process.pid!)
        memory.push({ elapsedMs: Date.now() - started, processes,
          rssBytes: processes.reduce((sum, p) => sum + p.rssBytes, 0),
          pssBytes: processes.reduce((sum, p) => sum + p.pssBytes, 0),
          privateBytes: processes.reduce((sum, p) => sum + p.privateBytes, 0) })
      }
      catch (error) { sampleError = error; return }
      await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    }
  })()
  const report: Record<string, unknown> = { inputs, requestedDurationMs: duration,
    appAsarSha256: archiveHash,
    inputMethod: 'X11 clipboard paste in isolated Xvfb', memoryMethod: '/proc/PID/smaps_rollup; descendants from every task/*/children',
    traceRecording: test.info().project.use.trace ?? 'off' }
  try {
    const controls = await surface(application, 'controls')
    const overlay = await surface(application, 'overlay')
    report.runtime = await controls.evaluate(async () => {
      const { appVersion, electronVersion, nodeVersion } = await window.controlsApi.getAbout()
      return { appVersion, electronVersion, nodeVersion }
    })
    await expect.poll(async () => controls.evaluate(async () => (await window.controlsApi.bootstrap()).snapshot.documents.length), { timeout: 30000 }).toBe(3)
    const documents = await controls.evaluate(async () => (await window.controlsApi.bootstrap()).snapshot.documents)
    const large = documents.find((document) => document.sourcePath === largePath)!
    const editable = documents.find((document) => document.sourcePath === editPath)!
    await controls.evaluate((id) => window.controlsApi.selectDocument(id), large.id)
    await expect.poll(() => overlay.locator('.overlay__text').evaluate((element) => element.textContent?.length ?? 0)).toBeGreaterThan(8000000)
    expect(await overlay.locator('.overlay__text').getAttribute('class')).not.toContain('overlay__text--md')
    await controls.evaluate((id) => window.controlsApi.selectDocument(id), editable.id)
    await controls.evaluate(() => window.controlsApi.updatePreferences({ editMode: true }))
    const editor = controls.getByRole('textbox', { name: 'Edit declarations.txt' })
    await expect(editor).toBeVisible()
    const queue = await controls.evaluate(async (path) => Promise.allSettled(Array.from({ length: 24 }, () => window.controlsApi.openRecent(path))), recentPath)
    report.importBurst = { admitted: queue.filter((result) => result.status === 'fulfilled' && result.value.ok).length,
      refused: queue.filter((result) => result.status === 'rejected' || !result.value.ok).length }
    await controls.evaluate((id) => window.controlsApi.selectDocument(id), editable.id)
    let iterations = 0
    let latest = content
    const workloadStart = Date.now()
    while (Date.now() - workloadStart < duration) {
      const t0 = performance.now()
      latest = iterations % 3 === 0 ? content : iterations % 3 === 1 ? readme : security
      // Chromium's CDP Input.insertText (used by fill) lays out each newline.
      // Exercise the actual user paste path, including real input/change events.
      const clipboard = spawnSync('xclip', ['-selection', 'clipboard', '-in'],
        { input: latest, stdio: ['pipe', 'ignore', 'ignore'] })
      if (clipboard.error) throw clipboard.error
      if (clipboard.status !== 0) throw new Error(`xclip failed with status ${clipboard.status}`)
      await editor.focus({ timeout: 10000 })
      await controls.keyboard.press('Control+A')
      const pasteStart = performance.now()
      await controls.keyboard.press('Control+V')
      await expect.poll(() => editor.inputValue({ timeout: 10000 })).toBe(latest)
      pasteLatencyMs.push(performance.now() - pasteStart)
      await editor.blur()
      await expect.poll(async () => controls.evaluate(async () => (await window.controlsApi.bootstrap()).activeDocument?.content.length)).toBe(latest.length)
      await controls.evaluate((iteration) => window.controlsApi.updatePreferences({ bannerMode: iteration % 2 === 0 }), iterations)
      await controls.evaluate(() => window.controlsApi.togglePlayback())
      await controls.evaluate((position) => window.controlsApi.seek(position), (iterations % 10) / 10)
      await controls.evaluate(() => window.controlsApi.togglePlayback())
      latencyMs.push(performance.now() - t0)
      iterations += 1
      if (application.process.exitCode !== null) throw new Error(`app exited ${application.process.exitCode}`)
      await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    }
    expect(Math.max(...latencyMs), 'every edit/layout/playback cycle finishes within ten seconds').toBeLessThan(10000)
    const preservedHash = await controls.evaluate(async () => {
      const value = (await window.controlsApi.bootstrap()).activeDocument!.content
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
    })
    expect(preservedHash).toBe(createHash('sha256').update(latest).digest('hex'))
    await stop(application)
    const reopened = await launch(directory)
    try {
      const restored = await surface(reopened, 'controls')
      const state = await restored.evaluate(async () => {
        const value = await window.controlsApi.bootstrap()
        return { length: value.activeDocument?.content.length, playing: value.snapshot.playing }
      })
      expect(state).toEqual({ length: latest.length, playing: false })
      await stop(reopened)
    } finally { await stop(reopened).catch(() => undefined) }
    report.iterations = iterations
    report.contentHash = preservedHash
    report.passed = true
  } catch (error) {
    report.passed = false
    report.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    sampling = false
    await sampler
    const sorted = [...latencyMs].sort((a, b) => a - b)
    report.elapsedMs = Date.now() - started
    report.processTreeMemory = {
      peakRssBytes: Math.max(0, ...memory.map((sample) => sample.rssBytes)),
      peakPssBytes: Math.max(0, ...memory.map((sample) => sample.pssBytes)),
      peakPrivateBytes: Math.max(0, ...memory.map((sample) => sample.privateBytes)), samples: memory }
    report.iterationLatencyMs = { count: sorted.length, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted.at(-1) }
    const pasteSorted = [...pasteLatencyMs].sort((a, b) => a - b)
    report.pasteLatencyMs = { count: pasteSorted.length, median: pasteSorted[Math.floor(pasteSorted.length / 2)], p95: pasteSorted[Math.floor(pasteSorted.length * 0.95)], max: pasteSorted.at(-1) }
    if (sampleError) {
      report.passed = false
      report.samplingError = String(sampleError)
    }
    const output = process.env.TELEPROMPT_STRESS_REPORT
    if (output) {
      await mkdir(resolve(output, '..'), { recursive: true })
      await writeFile(output, JSON.stringify(report, null, 2) + '\n')
    }
    await stop(application).catch(() => undefined)
    if (application.process.exitCode === null) application.process.kill('SIGKILL')
    await rm(directory, { recursive: true, force: true })
    if (sampleError) throw sampleError
  }
})
