import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import { type ChildProcess, spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { ControlsApi, OverlayApi } from '../src/shared/ipc.js'

declare global {
  interface Window {
    controlsApi: ControlsApi
    overlayApi: OverlayApi
  }
}

export const readme = await readFile(resolve('README.md'), 'utf8')
export const security = await readFile(resolve('SECURITY.md'), 'utf8')

// Document bytes come from the repository; temporary .txt copies exercise plain-text import.
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

export async function launch(configDirectory: string, documents: string[] = []): Promise<RunningApp> {
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
  const handlePage = (page: Page) => page.on('dialog', (dialog) => {
    // Electron's will-prevent-unload handler owns this dialog and closes only
    // after its real editor flush. Playwright must not race it with auto-dismiss.
    if (dialog.type() !== 'beforeunload') throw new Error(`Unexpected JavaScript dialog: ${dialog.type()}`)
  })
  for (const context of browser.contexts()) {
    context.on('page', handlePage)
    for (const page of context.pages()) handlePage(page)
  }
  return { browser, process: child, output: () => logs }
}

export async function surface(application: RunningApp, name: 'controls' | 'overlay'): Promise<Page> {
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

export async function recoveredSurface(application: RunningApp, name: 'controls' | 'overlay'): Promise<Page> {
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

export async function stop(application: RunningApp): Promise<void> {
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
