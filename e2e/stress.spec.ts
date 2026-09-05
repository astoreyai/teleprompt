import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { launch, surface, stop } from './harness.js'
import { processTreeMemory, type ProcessMemory } from './process-memory.js'

test('sustained read-only file workload records latency, memory, queue pressure and durable selection', async () => {
  const duration = Number(process.env.TELEPROMPT_STRESS_MS ?? 300000)
  if (!Number.isFinite(duration) || duration < 10000) throw new Error('stress duration must be at least 10000ms')
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-stress-'))
  const originals = ['node_modules/typescript/lib/typescript.js', 'node_modules/typescript/lib/typescript.d.ts', 'README.md', 'SECURITY.md'].map(path => resolve(path))
  const sources = await Promise.all(originals.map(async (path) => {
    const [bytes, info] = await Promise.all([readFile(path), stat(path)])
    const copy = join(directory, `${basename(path)}.txt`)
    await copyFile(path, copy)
    return { original: path, path: copy, name: basename(path), length: bytes.toString('utf8').length,
      bannerLength: bytes.toString('utf8').replace(/\s+/g, ' ').trim().length,
      bytes: bytes.length, mtime: info.mtime.toISOString(), sha256: createHash('sha256').update(bytes).digest('hex') }
  }))
  const inputs = sources.map(({ original, path, ...input }) => input)
  const archive = join(dirname(resolve(process.env.TELEPROMPT_E2E_EXECUTABLE ?? 'release/linux-unpacked/teleprompt')), 'resources/app.asar')
  const archiveHash = createHash('sha256').update(await readFile(archive)).digest('hex')
  const application = await launch(directory, sources.map(source => source.path))
  const memory: Array<{ elapsedMs: number; rssBytes: number; pssBytes: number; privateBytes: number; processes: ProcessMemory[] }> = []
  const latencyMs: number[] = []
  const selectionLatencyMs: number[] = []
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
    inputMethod: 'Actual CLI file import, selection, reload, settings and playback through installed preload APIs', memoryMethod: '/proc/PID/smaps_rollup; descendants from every task/*/children',
    traceRecording: test.info().project.use.trace ?? 'off' }
  try {
    const controls = await surface(application, 'controls')
    const overlay = await surface(application, 'overlay')
    report.runtime = await controls.evaluate(async () => {
      const { appVersion, electronVersion, nodeVersion } = await window.controlsApi.getAbout()
      return { appVersion, electronVersion, nodeVersion }
    })
    await expect.poll(async () => controls.evaluate(async () => (await window.controlsApi.bootstrap()).snapshot.documents.length), { timeout: 30_000 }).toBe(sources.length)
    const documents = (await controls.evaluate(() => window.controlsApi.bootstrap())).snapshot.documents
    const playlist = sources.map(source => {
      const document = documents.find(document => document.sourcePath === source.path)
      expect(document).toBeDefined()
      return { source, document: document! }
    })
    const initial = (await controls.evaluate(() => window.controlsApi.bootstrap())).snapshot
    const queue = await controls.evaluate(async (path) => Promise.allSettled(Array.from({ length: 24 }, () => window.controlsApi.openRecent(path))), sources[2].path)
    report.importBurst = { admitted: queue.filter((result) => result.status === 'fulfilled' && result.value.ok).length,
      refused: queue.filter((result) => result.status === 'rejected' || !result.value.ok).length }
    let iterations = 0
    let latest = playlist[0]
    const workloadStart = Date.now()
    while (Date.now() - workloadStart < duration) {
      const t0 = performance.now()
      latest = playlist[iterations % playlist.length]
      // File bytes remain untouched. Exercise the same read-only workload on both binaries.
      const selectionStart = performance.now()
      expect((await controls.evaluate(id => window.controlsApi.selectDocument(id), latest.document.id)).ok).toBe(true)
      await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).activeDocument?.content.length).toBe(latest.source.length)
      selectionLatencyMs.push(performance.now() - selectionStart)
      if (iterations % playlist.length === 0) {
        expect((await controls.evaluate(id => window.controlsApi.reloadDocument(id), latest.document.id)).ok).toBe(true)
      }
      await controls.evaluate(({ bannerMode, mirrorH }) => window.controlsApi.updatePreferences({ bannerMode, mirrorH }),
        { bannerMode: iterations % 2 === 0, mirrorH: iterations % 2 === 0 ? !initial.mirrorH : initial.mirrorH })
      const text = overlay.locator(iterations % 2 === 0 ? '.banner__text' : '.overlay__text')
      await expect.poll(() => text.evaluate(element => element.textContent?.length ?? 0))
        .toBe(iterations % 2 === 0 ? latest.source.bannerLength : latest.source.length)
      expect((await controls.evaluate(() => window.controlsApi.togglePlayback())).ok).toBe(true)
      await controls.evaluate(position => window.controlsApi.seek(position), (iterations % 10) / 10)
      expect((await controls.evaluate(() => window.controlsApi.togglePlayback())).ok).toBe(true)
      latencyMs.push(performance.now() - t0)
      iterations += 1
      if (application.process.exitCode !== null) throw new Error(`app exited ${application.process.exitCode}`)
      await new Promise(resolveWait => setTimeout(resolveWait, 500))
    }
    expect(Math.max(...latencyMs), 'every selection/reload/layout/playback cycle finishes within ten seconds').toBeLessThan(10000)
    const hashDocument = async () => controls.evaluate(async () => {
      const value = (await window.controlsApi.bootstrap()).activeDocument!.content
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    })
    const preservedHash = await hashDocument()
    expect(preservedHash).toBe(latest.source.sha256)
    const final = (await controls.evaluate(() => window.controlsApi.bootstrap())).snapshot
    for (const source of sources) {
      expect(createHash('sha256').update(await readFile(source.path)).digest('hex')).toBe(source.sha256)
      expect(createHash('sha256').update(await readFile(source.original)).digest('hex')).toBe(source.sha256)
    }
    sampling = false
    await sampler
    await stop(application)
    const reopened = await launch(directory)
    try {
      const restored = await surface(reopened, 'controls')
      const state = await restored.evaluate(async () => {
        const value = await window.controlsApi.bootstrap()
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value.activeDocument!.content))
        return { sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
          id: value.snapshot.activeDocumentId, playing: value.snapshot.playing,
          bannerMode: value.snapshot.bannerMode, mirrorH: value.snapshot.mirrorH }
      })
      expect(state).toEqual({ sha256: preservedHash, id: latest.document.id, playing: false,
        bannerMode: final.bannerMode, mirrorH: final.mirrorH })
      await stop(reopened)
    } finally { await stop(reopened).catch(() => undefined) }
    report.iterations = iterations
    report.contentHash = preservedHash
    report.sourceFilesUnchanged = true
    report.restoredSelectionAndSettings = true
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
    const selectionSorted = [...selectionLatencyMs].sort((a, b) => a - b)
    report.selectionLatencyMs = { count: selectionSorted.length, median: selectionSorted[Math.floor(selectionSorted.length / 2)], p95: selectionSorted[Math.floor(selectionSorted.length * 0.95)], max: selectionSorted.at(-1) }
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
