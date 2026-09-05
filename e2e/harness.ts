import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import { type ChildProcess, spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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

const launchedProcesses: Array<{
  process: ChildProcess
  output: () => string
  beforeStop?: Array<Record<string, string | number>>
}> = []

async function processSnapshot(pid: number): Promise<Array<Record<string, string | number>>> {
  const pending = [pid]
  const observed = new Set<number>()
  const records: Array<Record<string, string | number>> = []
  while (pending.length && observed.size < 64) {
    const current = pending.shift()!
    if (observed.has(current)) continue
    observed.add(current)
    const read = async (path: string): Promise<string> => readFile(`/proc/${current}/${path}`, 'utf8')
      .then((value) => value.slice(0, 16_384).trim())
      .catch((error: unknown) => `READ ERROR: ${String(error)}`)
    const [status, wchan, profile, cmdline] = await Promise.all([
      read('status'), read('wchan'), read('attr/current'), read('cmdline'),
    ])
    const tasks = await readdir(`/proc/${current}/task`).catch((error: unknown) => `READ ERROR: ${String(error)}`)
    const threadIds = Array.isArray(tasks) ? tasks.filter((id) => /^\d+$/.test(id)) : []
    const children = await Promise.all(threadIds.slice(0, 256).map(async (id) => ({
      thread: id, pids: await read(`task/${id}/children`),
    })))
    records.push({ pid: current,
      status: status.startsWith('READ ERROR:') ? status : status.split('\n')
        .filter((line) => /^(Name|State|PPid|TracerPid|Uid|Gid|NoNewPrivs|Seccomp):/.test(line)).join('\n'),
      wchan, profile, cmdline: cmdline.replaceAll('\0', ' '),
      children: typeof tasks === 'string' ? tasks : JSON.stringify(children),
      threadsOmitted: Math.max(0, threadIds.length - 256),
    })
    for (const childList of children) {
      if (!childList.pids.startsWith('READ ERROR:')) {
        pending.push(...childList.pids.split(/\s+/).filter(Boolean).map(Number).filter((child) => child > 0))
      }
    }
  }
  if (pending.length) records.push({ limit: 'Stopped after 64 known application processes' })
  return records
}

test.afterEach(async ({}, info) => {
  const processes = launchedProcesses.splice(0)
  if (info.status === info.expectedStatus) return
  for (const [index, application] of processes.entries()) {
    const output = Buffer.from(application.output())
    const outputTruncatedBytes = Math.max(0, output.length - 64 * 1024)
    await info.attach(`native-process-${index}`, {
      body: JSON.stringify({
        pid: application.process.pid,
        exitCode: application.process.exitCode,
        signalCode: application.process.signalCode,
        argv: application.process.spawnargs,
        output: output.subarray(outputTruncatedBytes).toString('utf8'),
        outputTruncatedBytes,
        beforeStop: application.beforeStop,
      }, null, 2),
      contentType: 'application/json',
    })
  }
})

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
  launchedProcesses.push({ process: child, output: () => logs })
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
    // Electron owns window-close handling and persistence. Playwright must not
    // race a native beforeunload handler with automatic dialog dismissal.
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
    const tracked = launchedProcesses.find((entry) => entry.process === application.process)
    if (tracked && !tracked.beforeStop && application.process.pid) {
      tracked.beforeStop = await processSnapshot(application.process.pid)
    }
    const exited = new Promise<void>((resolveExited) => application.process.once('exit', () => resolveExited()))
    application.process.kill('SIGTERM')
    await Promise.race([
      exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Teleprompt did not exit cleanly\n${application.output()}`)), 8000)),
    ])
  }
  await application.browser.close().catch(() => undefined)
}
