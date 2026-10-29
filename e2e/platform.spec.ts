import { chromium, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, readme, recoveredSurface, stop, surface } from './harness.js'

function native(command: string, ...args: string[]): string {
  if (!process.env.TELEPROMPT_TEST_DISPLAY || process.env.DISPLAY !== process.env.TELEPROMPT_TEST_DISPLAY) {
    throw new Error('Native acceptance requires the isolated TELEPROMPT_TEST_DISPLAY from xvfb-run')
  }
  return execFileSync(command, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

test('native Retry restores the real document and resets the exhausted renderer budget', async () => {
  test.setTimeout(60_000)
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-native-retry-'))
  const source = join(directory, 'README.txt')
  await writeFile(source, readme)
  const application = await launch(directory, [source])
  try {
    let controls = await surface(application, 'controls')
    await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).activeDocument?.content).toBe(readme)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const session = await controls.context().newCDPSession(controls)
      const crashed = controls.waitForEvent('crash')
      void session.send('Page.crash').catch(() => undefined)
      await crashed
      if (attempt < 3) controls = await recoveredSurface(application, 'controls')
    }
    const log = join(directory, 'teleprompt', 'logs', 'teleprompt-crash.log')
    await expect.poll(() => readFile(log, 'utf8')).toContain('renderer recovery budget exhausted[controls]')
    let dialog = ''
    await expect.poll(() => {
      try { dialog = native('xdotool', 'search', '--onlyvisible', '--name', '^Teleprompt renderer failed$').split('\n')[0] }
      catch { dialog = '' }
      return dialog
    }).not.toBe('')
    native('xdotool', 'windowfocus', '--sync', dialog)
    // The real native dialog defaults to Keep stopped. Tab selects its Retry button.
    native('xdotool', 'key', '--clearmodifiers', 'Tab', 'Return')
    controls = await recoveredSurface(application, 'controls')
    expect((await controls.evaluate(() => window.controlsApi.bootstrap())).activeDocument?.content).toBe(readme)
    const session = await controls.context().newCDPSession(controls)
    const crashed = controls.waitForEvent('crash')
    void session.send('Page.crash').catch(() => undefined)
    await crashed
    controls = await recoveredSurface(application, 'controls')
    expect((await controls.evaluate(() => window.controlsApi.bootstrap())).activeDocument?.content).toBe(readme)
  } finally {
    await stop(application).catch(() => undefined)
    if (application.process.exitCode === null) application.process.kill('SIGKILL')
    await rm(directory, { recursive: true, force: true })
  }
})

test('an actually unresponsive renderer recovers with its real document', async () => {
  test.setTimeout(60_000)
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-native-hang-'))
  const source = join(directory, 'README.txt')
  await writeFile(source, readme)
  const application = await launch(directory, [source])
  try {
    let controls = await surface(application, 'controls')
    const overlay = await surface(application, 'overlay')
    await overlay.waitForLoadState('load')
    await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).activeDocument?.content).toBe(readme)
    const session = await controls.context().newCDPSession(controls)
    // Fault injection stalls the actual renderer thread; no event or runtime API is replaced.
    await session.send('Runtime.evaluate', { expression: 'setTimeout(() => { while (true) {} }, 0)' })
    const windowId = native('xdotool', 'search', '--onlyvisible', '--name', 'Teleprompt.*Controls').split('\n')[0]
    // Detach the debugger while observing native hang detection. Closing a
    // connectOverCDP connection disconnects it and leaves the app running.
    await application.browser.close()
    expect(application.process.exitCode).toBeNull()
    native('xdotool', 'windowfocus', '--sync', windowId)
    native('xdotool', 'mousemove', '--window', windowId, '200', '200', 'click', '1')
    const log = join(directory, 'teleprompt', 'logs', 'teleprompt-crash.log')
    await expect.poll(() => readFile(log, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return ''
      throw error
    }), { timeout: 30_000 }).toContain('unresponsive[controls]')
    await expect.poll(() => {
      try { native('xdotool', 'getwindowname', windowId); return true }
      catch { return false }
    }, { timeout: 15_000 }).toBe(false)
    const port = application.process.spawnargs.find(argument => argument.startsWith('--remote-debugging-port='))?.split('=')[1]
    expect(port).toBeTruthy()
    application.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    for (const context of application.browser.contexts()) {
      const retainNativeClose = (page: import('@playwright/test').Page) => page.on('dialog', (dialog) => {
        if (dialog.type() !== 'beforeunload') throw new Error(`Unexpected JavaScript dialog: ${dialog.type()}`)
      })
      context.on('page', retainNativeClose)
      for (const page of context.pages()) retainNativeClose(page)
    }
    controls = await recoveredSurface(application, 'controls')
    expect((await controls.evaluate(() => window.controlsApi.bootstrap())).activeDocument?.content).toBe(readme)
  } finally {
    const log = await readFile(join(directory, 'teleprompt', 'logs', 'teleprompt-crash.log')).catch(() => Buffer.alloc(0))
    await test.info().attach('native-hang-log', { body: log, contentType: 'text/plain' })
    await stop(application).catch(() => undefined)
    if (application.process.exitCode === null) application.process.kill('SIGKILL')
    await rm(directory, { recursive: true, force: true })
  }
})

test('native preference import recalculates pacing and recreates the overlay', async () => {
  test.setTimeout(90_000)
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-preference-import-'))
  const source = join(directory, 'README.txt')
  await writeFile(source, readme)
  const application = await launch(directory, [source])
  try {
    const controls = await surface(application, 'controls')
    const overlay = await surface(application, 'overlay')
    await expect(overlay.locator('.overlay__text')).toContainText('Teleprompt')
    const current = (await controls.evaluate(() => window.controlsApi.bootstrap())).snapshot
    // Capture actual application preferences; change only the settings under test.
    const path = join(directory, 'preferences.json')
    await writeFile(path, JSON.stringify({ version: 1, preferences: {
      ...current, targetMode: 'duration', targetDurationSec: 120,
      aboveFullscreen: !current.aboveFullscreen,
    }, hotkeyBindings: current.hotkeyBindings }))
    const imported = controls.evaluate(() => window.controlsApi.importPreferences())
    let dialog = ''
    await expect.poll(() => {
      try { dialog = native('xdotool', 'search', '--onlyvisible', '--name', 'Import Teleprompt preferences|Open File|Open').split('\n')[0] }
      catch { dialog = '' }
      return dialog
    }, { timeout: 60_000 }).not.toBe('')
    native('xdotool', 'windowfocus', '--sync', dialog)
    native('xdotool', 'key', '--clearmodifiers', 'ctrl+l')
    native('xdotool', 'type', '--clearmodifiers', path)
    native('xdotool', 'key', '--clearmodifiers', 'Return')
    await controls.waitForTimeout(300)
    native('xdotool', 'key', '--clearmodifiers', 'Return')
    expect(await imported).toEqual({ ok: true })
    await expect.poll(() => overlay.isClosed()).toBe(true)
    const replacement = await recoveredSurface(application, 'overlay')
    await expect(replacement.locator('.overlay__text')).toContainText('Teleprompt')
    const range = await replacement.locator('.overlay__text').evaluate(element =>
      Math.max(0, element.scrollHeight - element.parentElement!.clientHeight))
    await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).snapshot.scrollSpeed)
      .toBeCloseTo(Math.max(1, Math.min(2000, range / 120)), 0)
  } finally {
    await stop(application).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})
