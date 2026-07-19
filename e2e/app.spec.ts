import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ControlsApi, OverlayApi } from '../src/shared/ipc.js'

declare global {
  interface Window {
    controlsApi: ControlsApi
    overlayApi: OverlayApi
  }
}

const executablePath = resolve(
  process.env.TELEPROMPT_E2E_EXECUTABLE ?? 'release/linux-unpacked/teleprompt',
)

type RunningApp = {
  browser: Browser
  process: ChildProcess
  output: () => string
}

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveReady, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveReady)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()))
  if (!port) throw new Error('could not allocate a CDP port')
  return port
}

async function launch(configDirectory: string, documents: string[] = []): Promise<RunningApp> {
  const port = await availablePort()
  const child = spawn(
    executablePath,
    [`--remote-debugging-port=${port}`, '--disable-gpu', ...documents],
    {
      env: { ...process.env, XDG_CONFIG_HOME: configDirectory },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let logs = ''
  child.stdout?.on('data', (chunk) => { logs += String(chunk) })
  child.stderr?.on('data', (chunk) => { logs += String(chunk) })
  const endpoint = `http://127.0.0.1:${port}`
  let browser: Browser | null = null
  for (let attempt = 0; attempt < 100 && !browser; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Teleprompt exited during launch (${child.exitCode})\n${logs}`)
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 500 })
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
  }
  if (!browser) {
    child.kill('SIGTERM')
    throw new Error(`Timed out connecting to Teleprompt\n${logs}`)
  }
  return { browser, process: child, output: () => logs }
}

async function surface(application: RunningApp, name: 'controls' | 'overlay'): Promise<Page> {
  let result: Page | undefined
  await expect.poll(() => {
    result = application.browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url() === `teleprompt://app/${name}.html`)
    return !!result
  }).toBe(true)
  return result!
}

async function recoveredSurface(application: RunningApp, name: 'controls' | 'overlay'): Promise<Page> {
  let result: Page | undefined
  await expect.poll(async () => {
    const candidates = application.browser
      .contexts()
      .flatMap((context) => context.pages())
      .filter((page) => page.url() === `teleprompt://app/${name}.html`)
    for (const candidate of candidates) {
      const healthy = await candidate.evaluate(() => document.readyState === 'complete' && !!document.querySelector('#root')).catch(() => false)
      if (healthy) {
        result = candidate
        return true
      }
    }
    return false
  }, { timeout: 10_000 }).toBe(true)
  return result!
}

async function stop(application: RunningApp): Promise<void> {
  if (application.process.exitCode === null) {
    const exited = new Promise<void>((resolveExited) => application.process.once('exit', () => resolveExited()))
    application.process.kill('SIGTERM')
    await Promise.race([
      exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Teleprompt did not exit cleanly\n${application.output()}`)), 8000)),
    ])
  }
  await application.browser.close().catch(() => undefined)
}

test('packaged importer survives its process boundary and refuses an external-edit overwrite', async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), 'teleprompt-e2e-import-'))
  const sourcePath = join(configDirectory, 'source.txt')
  await writeFile(sourcePath, 'source text from disk', 'utf8')
  let application = await launch(configDirectory, [sourcePath])
  try {
    let controls = await surface(application, 'controls')
    const overlay = await surface(application, 'overlay')
    const imported = await controls.evaluate(() => window.controlsApi.bootstrap())
    expect(imported.activeDocument?.content).toBe('source text from disk')
    const metadata = imported.snapshot.documents[0]
    expect(metadata).toMatchObject({ sourcePath, dirty: false, saveMode: 'overwrite' })
    const overlayBootstrap = await overlay.evaluate(() => window.overlayApi.bootstrap())
    expect(overlayBootstrap.snapshot.activeDocumentMeta).toMatchObject({
      id: metadata.id,
      format: 'text',
    })
    expect(JSON.stringify(overlayBootstrap.snapshot)).not.toContain(sourcePath)
    expect(overlayBootstrap.snapshot).not.toHaveProperty('documents')
    expect(overlayBootstrap.snapshot).not.toHaveProperty('recentFiles')

    const updated = await controls.evaluate(
      ({ id, revision }) => window.controlsApi.updateDocument(id, revision, 'local recovery draft'),
      { id: metadata.id, revision: metadata.revision },
    )
    expect(updated.ok).toBe(true)
    await writeFile(sourcePath, 'newer external content', 'utf8')

    const saveResult = await controls.evaluate((id) => window.controlsApi.saveDocument(id), metadata.id)
    expect(saveResult).toMatchObject({ ok: false, reason: 'conflict' })
    expect(await readFile(sourcePath, 'utf8')).toBe('newer external content')

    await stop(application)
    application = await launch(configDirectory)
    controls = await surface(application, 'controls')
    const restored = await controls.evaluate(() => window.controlsApi.bootstrap())
    expect(restored.activeDocument?.content).toBe('local recovery draft')
    expect(restored.snapshot.documents[0]).toMatchObject({ id: metadata.id, dirty: true })
  } finally {
    await stop(application).catch(() => undefined)
    await rm(configDirectory, { recursive: true, force: true })
  }
})

test('packaged app isolates surfaces, recovers drafts, and runs playback checkpoints', async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), 'teleprompt-e2e-'))
  let application = await launch(configDirectory)
  try {
    let controls = await surface(application, 'controls')
    let overlay = await surface(application, 'overlay')

    await expect.poll(() => controls.evaluate(() => document.readyState)).toBe('complete')
    await expect.poll(() => overlay.evaluate(() => document.readyState)).toBe('complete')
    expect(await controls.evaluate(() => ({ controls: typeof window.controlsApi, overlay: typeof window.overlayApi, legacy: typeof (window as unknown as { api?: unknown }).api })))
      .toEqual({ controls: 'object', overlay: 'undefined', legacy: 'undefined' })
    expect(await overlay.evaluate(() => ({ controls: typeof window.controlsApi, overlay: typeof window.overlayApi })))
      .toEqual({ controls: 'undefined', overlay: 'object' })

    await controls.getByRole('button', { name: 'New blank script' }).click()
    const editor = controls.getByRole('textbox', { name: /Edit untitled-/ })
    await expect(editor).toBeVisible()
    const uniqueText = `Architecture recovery ${Date.now()} ` + 'safe playback text '.repeat(80)
    await editor.fill(uniqueText)
    await editor.blur()
    await expect(overlay.locator('.overlay__text')).toContainText('Architecture recovery')

    const bootstrap = await controls.evaluate(() => window.controlsApi.bootstrap())
    expect(bootstrap.activeDocument?.content).toContain('Architecture recovery')
    expect(JSON.stringify(bootstrap.snapshot)).not.toContain(uniqueText)
    expect(bootstrap.snapshot.documents).toHaveLength(1)
    expect(bootstrap.snapshot.documents[0].dirty).toBe(true)

    await controls.getByRole('button', { name: 'Play', exact: true }).click()
    await expect(controls.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await expect.poll(async () => Number(await controls.locator('#playback-position').inputValue())).toBeGreaterThan(0)
    await controls.getByRole('button', { name: 'Pause', exact: true }).click()

    await stop(application)
    application = await launch(configDirectory)
    controls = await surface(application, 'controls')
    overlay = await surface(application, 'overlay')
    const restored = await controls.evaluate(() => window.controlsApi.bootstrap())
    expect(restored.activeDocument?.content).toBe(uniqueText)
    expect(restored.snapshot.playing).toBe(false)
    expect(restored.snapshot.voiceStatus).toBe('off')
    expect(restored.snapshot.clickerMode).toBe(false)
    expect(restored.snapshot.drivePresentation).toBe(false)
    await expect(overlay.locator('.overlay__text')).toContainText('Architecture recovery')
    const editorToggle = controls.getByRole('checkbox', { name: /Show live editor/ })
    await editorToggle.click()
    await expect(editorToggle).toBeChecked()
    await expect(controls.getByRole('textbox', { name: /Edit untitled-/ })).toHaveValue(uniqueText)

    const crashSession = await controls.context().newCDPSession(controls)
    await crashSession.send('Page.crash').catch(() => undefined)
    controls = await recoveredSurface(application, 'controls')
    const afterRendererRecovery = await controls.evaluate(() => window.controlsApi.bootstrap())
    expect(afterRendererRecovery.activeDocument?.content).toBe(uniqueText)
    expect(afterRendererRecovery.snapshot.playing).toBe(false)
  } finally {
    await stop(application).catch(() => undefined)
    await rm(configDirectory, { recursive: true, force: true })
  }
})
