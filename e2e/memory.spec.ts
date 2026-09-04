import { expect, test, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launch, surface, stop, readme } from './harness.js'
import { processTreeMemory } from './process-memory.js'

async function paste(page: Page, value: string) {
  const result = spawnSync('xclip', ['-selection', 'clipboard', '-in'],
    { input: value, stdio: ['pipe', 'ignore', 'ignore'] })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`xclip failed with status ${result.status}`)
  const editor = page.getByRole('textbox', { name: 'Edit README.md' })
  await editor.focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Control+V')
  await expect(editor).toHaveValue(value)
  await editor.blur()
  await expect.poll(async () => page.evaluate(async () => (await window.controlsApi.bootstrap()).activeDocument?.content)).toBe(value)
}

for (const restart of [false, true]) {
  test(`large-to-small ${restart ? 'restored' : 'new'} document transitions release unused memory without discarding native Undo`, async () => {
    test.setTimeout(60000)
    if (!process.env.TELEPROMPT_TEST_DISPLAY || process.env.TELEPROMPT_TEST_DISPLAY !== process.env.DISPLAY) {
      throw new Error('Use npm run test:e2e so clipboard operations stay in an isolated Xvfb display')
    }
    const directory = await mkdtemp(join(tmpdir(), 'teleprompt-memory-'))
    const large = await readFile(resolve('node_modules/typescript/lib/typescript.js'), 'utf8')
    const declarations = await readFile(resolve('node_modules/typescript/lib/typescript.d.ts'), 'utf8')
    let app = await launch(directory)
    try {
      let controls = await surface(app, 'controls')
      let overlay = await surface(app, 'overlay')
      await controls.evaluate((content) => window.controlsApi.createDocument('typescript.js', content, 'text'), large)
      await expect.poll(() => overlay.locator('.overlay__text').evaluate(element => element.textContent?.length), { timeout: 15000 }).toBe(large.length)
      if (restart) {
        await stop(app)
        app = await launch(directory)
        controls = await surface(app, 'controls')
        overlay = await surface(app, 'overlay')
        await expect.poll(() => overlay.locator('.overlay__text').evaluate(element => element.textContent?.length), { timeout: 15000 }).toBe(large.length)
      }
      await controls.evaluate((content) => window.controlsApi.createDocument('README.md', content, 'markdown'), readme)
      await expect(overlay.locator('.overlay__text')).toContainText('Teleprompt')
      await expect.poll(async () => (await processTreeMemory(app.process.pid!)).reduce((sum, p) => sum + p.privateBytes, 0),
        { timeout: 15000, message: 'private memory falls below 512 MiB after leaving the 9 MB document' }).toBeLessThan(512 * 1024 * 1024)
      await controls.evaluate(() => window.controlsApi.updatePreferences({ editMode: true }))
      await paste(controls, declarations)
      await paste(controls, readme)
      // Observe beyond the deferred release, then exercise the actual native Undo/Redo stack.
      await new Promise(resolveWait => setTimeout(resolveWait, 750))
      const editor = controls.getByRole('textbox', { name: 'Edit README.md' })
      await editor.focus()
      await controls.keyboard.press('Control+Z')
      await expect(editor).toHaveValue(declarations)
      await controls.keyboard.press('Control+Shift+Z')
      await expect(editor).toHaveValue(readme)
      await stop(app)
    } finally {
      await stop(app).catch(() => undefined)
      if (app.process.exitCode === null && app.process.signalCode === null) app.process.kill('SIGKILL')
      await rm(directory, { recursive: true, force: true })
    }
  })
}
