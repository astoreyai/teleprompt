import { expect, test } from '@playwright/test'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { launch, surface, recoveredSurface, stop, readme, security } from './harness.js'

test('packaged importer survives its process boundary and refuses an external-edit overwrite', async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), 'teleprompt-e2e-import-'))
  const sourcePath = join(configDirectory, 'source.txt')
  await writeFile(sourcePath, readme, 'utf8')
  let application = await launch(configDirectory, [sourcePath])
  try {
    let controls = await surface(application, 'controls')
    const overlay = await surface(application, 'overlay')
    await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).activeDocument?.content).toBe(readme)
    const imported = await controls.evaluate(() => window.controlsApi.bootstrap())
    expect(imported.activeDocument?.content).toBe(readme)
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
      ({ id, revision, content }) => window.controlsApi.updateDocument(id, revision, content),
      { id: metadata.id, revision: metadata.revision, content: security },
    )
    expect(updated.ok).toBe(true)
    await writeFile(sourcePath, readme + security, 'utf8')

    const saveResult = await controls.evaluate((id) => window.controlsApi.saveDocument(id), metadata.id)
    expect(saveResult).toMatchObject({ ok: false, reason: 'conflict' })
    expect(await readFile(sourcePath, 'utf8')).toBe(readme + security)

    await stop(application)
    application = await launch(configDirectory)
    controls = await surface(application, 'controls')
    const restored = await controls.evaluate(() => window.controlsApi.bootstrap())
    expect(restored.activeDocument?.content).toBe(security)
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
    const uniqueText = readme
    expect(await editor.inputValue()).toBe('')
    await editor.fill(uniqueText)
    await editor.blur()
    await expect(overlay.locator('.overlay__text')).toContainText(readme.split('\n')[0].replace(/^#+\s*/, ''))

    const bootstrap = await controls.evaluate(() => window.controlsApi.bootstrap())
    expect(bootstrap.activeDocument?.content).toBe(readme)
    expect(JSON.stringify(bootstrap.snapshot)).not.toContain(uniqueText)
    expect(bootstrap.snapshot.documents).toHaveLength(1)
    expect(bootstrap.snapshot.documents[0].dirty).toBe(true)

    await controls.getByRole('button', { name: 'Play', exact: true }).click()
    await expect(controls.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await expect.poll(async () => Number(await controls.locator('#playback-position').inputValue())).toBeGreaterThan(0)
    const beforeSeek = await overlay.evaluate(() => window.overlayApi.bootstrap())
    await controls.evaluate(() => window.controlsApi.seek(0))
    const stale = await overlay.evaluate((snapshot) => window.overlayApi.checkpoint({
      documentId: snapshot.activeDocumentMeta!.id, revision: snapshot.activeDocumentMeta!.revision,
      sessionId: snapshot.playbackSessionId!, seekGeneration: snapshot.seekGeneration,
      position: snapshot.scrollPosition, terminal: true,
    }), beforeSeek.snapshot)
    expect(stale.ok).toBe(false)
    await expect(controls.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await controls.getByRole('button', { name: 'Pause', exact: true }).click()

    // Change the actual UI and quit without waiting for the editor debounce.
    await editor.fill(security)
    await stop(application)
    application = await launch(configDirectory)
    controls = await surface(application, 'controls')
    overlay = await surface(application, 'overlay')
    const restored = await controls.evaluate(() => window.controlsApi.bootstrap())
    expect(restored.activeDocument?.content).toBe(security)
    expect(restored.snapshot.playing).toBe(false)
    expect(restored.snapshot.voiceStatus).toBe('off')
    expect(restored.snapshot.clickerMode).toBe(false)
    expect(restored.snapshot.drivePresentation).toBe(false)
    await expect(overlay.locator('.overlay__text')).toContainText(security.split('\n')[0].replace(/^#+\s*/, ''))
    const editorToggle = controls.getByRole('checkbox', { name: /Show live editor/ })
    await editorToggle.click()
    await expect(editorToggle).toBeChecked()
    await expect(controls.getByRole('textbox', { name: /Edit untitled-/ })).toHaveValue(security)

    const crashSession = await controls.context().newCDPSession(controls)
    await crashSession.send('Page.crash').catch(() => undefined)
    controls = await recoveredSurface(application, 'controls')
    const afterRendererRecovery = await controls.evaluate(() => window.controlsApi.bootstrap())
    expect(afterRendererRecovery.activeDocument?.content).toBe(security)
    expect(afterRendererRecovery.snapshot.playing).toBe(false)
  } finally {
    await stop(application).catch(() => undefined)
    await rm(configDirectory, { recursive: true, force: true })
  }
})

for (const role of ['controls', 'overlay'] as const) {
  test(`packaged ${role} recovery stops after three replacements`, async () => {
    test.setTimeout(45_000)
    const directory = await mkdtemp(join(tmpdir(), 'teleprompt-e2e-budget-'))
    const source = join(directory, 'README.txt')
    await writeFile(source, readme)
    const application = await launch(directory, [source])
    try {
      let page = await surface(application, role)
      const controls = await surface(application, 'controls')
      await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).activeDocument?.content).toBe(readme)
      const initial = await application.browser.newBrowserCDPSession()
      const targetIds = new Set<string>()
      for (let index = 0; index < 4; index += 1) {
        const session = await page.context().newCDPSession(page)
        const info = await session.send('Target.getTargetInfo')
        targetIds.add(info.targetInfo.targetId)
        const crashed = page.waitForEvent('crash', { timeout: 5000 })
        void session.send('Page.crash').catch(() => undefined)
        await crashed
        if (index < 3) {
          page = await recoveredSurface(application, role)
          const recovered = await page.evaluate(async (surfaceRole) => {
            const payload = surfaceRole === 'controls' ? await window.controlsApi.bootstrap() : await window.overlayApi.bootstrap()
            return payload.activeDocument?.content
          }, role)
          expect(recovered).toBe(readme)
        }
      }
      expect(targetIds.size).toBe(4)
      const logPath = join(directory, 'teleprompt', 'logs', 'teleprompt-crash.log')
      await expect.poll(async () => readFile(logPath, 'utf8').catch(() => '')).toContain(`renderer recovery budget exhausted[${role}]`)
      // Observe beyond the longest scheduled recovery delay, then inspect actual targets.
      await new Promise((resolveWait) => setTimeout(resolveWait, 4500))
      const { targetInfos } = await initial.send('Target.getTargets')
      expect(targetInfos.filter((target) => target.url === `teleprompt://app/${role}.html`)
        .every((target) => targetIds.has(target.targetId))).toBe(true)
      const surviving = await surface(application, role === 'controls' ? 'overlay' : 'controls')
      expect(await surviving.evaluate(() => document.readyState)).toBe('complete')
      await stop(application)
      // Real Crashpad output from this native run; keep process-memory artifacts local.
      const pending = join(directory, 'teleprompt', 'Crashpad', 'pending')
      const corpus = test.info().outputPath('crash-corpus')
      await mkdir(corpus, { recursive: true, mode: 0o700 })
      const artifacts = []
      for (const name of (await readdir(pending)).filter(name => /\.(dmp|meta)$/.test(name))) {
        const path = join(pending, name)
        const bytes = await readFile(path)
        const info = await stat(path)
        await copyFile(path, join(corpus, name))
        artifacts.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
          sourceMtime: info.mtime.toISOString() })
      }
      expect(artifacts.some(file => file.name.endsWith('.dmp'))).toBe(true)
      expect(artifacts.some(file => file.name.endsWith('.meta'))).toBe(true)
      const executable = resolve(process.env.TELEPROMPT_E2E_EXECUTABLE ?? 'release/linux-unpacked/teleprompt')
      const asar = await readFile(join(dirname(executable), 'resources', 'app.asar'))
      await writeFile(join(corpus, 'provenance.json'), JSON.stringify({
        origin: test.info().title, capturedAt: new Date().toISOString(),
        trigger: 'Four real renderer crashes through CDP Page.crash after importing the repository README',
        applicationSha256: createHash('sha256').update(asar).digest('hex'),
        inputSha256: createHash('sha256').update(readme).digest('hex'),
        transformation: 'Unmodified Crashpad bytes copied after application shutdown', artifacts,
      }, null, 2) + '\n')
    } finally {
      await stop(application).catch(() => undefined)
      if (application.process.exitCode === null) application.process.kill('SIGKILL')
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('native Controls close drains the editor and a cleared document survives restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-e2e-close-'))
  let application = await launch(directory)
  try {
    let controls = await surface(application, 'controls')
    const overlay = await surface(application, 'overlay')
    await controls.getByRole('button', { name: 'New blank script' }).click()
    let editor = controls.getByRole('textbox', { name: /Edit untitled-/ })
    await editor.fill(readme)
    await editor.blur()
    await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).activeDocument?.content).toBe(readme)
    await editor.fill(security)
    await controls.evaluate(() => window.close())
    await expect.poll(() => controls.isClosed()).toBe(true)
    await overlay.evaluate(() => window.overlayApi.focusControls())
    controls = await recoveredSurface(application, 'controls')
    editor = controls.getByRole('textbox', { name: /Edit untitled-/ })
    await expect(editor).toHaveValue(security)
    await editor.fill('')
    await stop(application)
    application = await launch(directory)
    controls = await surface(application, 'controls')
    const restored = await controls.evaluate(() => window.controlsApi.bootstrap())
    expect(restored.snapshot.documents).toHaveLength(1)
    expect(restored.activeDocument?.content).toBe('')
    await stop(application)
  } finally {
    await test.info().attach('main-process-log', { body: await readFile(join(directory, 'teleprompt', 'logs', 'teleprompt-crash.log')).catch(() => Buffer.alloc(0)), contentType: 'text/plain' })
    await stop(application).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('geometry follows mounted content and layout while confirmations trap keyboard focus', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-e2e-layout-'))
  const application = await launch(directory)
  try {
    const controls = await surface(application, 'controls')
    const overlay = await surface(application, 'overlay')
    await controls.getByRole('button', { name: 'New blank script' }).click()
    await controls.getByRole('textbox', { name: /Edit untitled-/ }).fill(readme)
    await controls.getByRole('textbox', { name: /Edit untitled-/ }).blur()
    await expect(overlay.locator('.overlay__text')).toContainText(readme.split('\n')[0].replace(/^#+\s*/, ''))
    const initialHeight = await overlay.locator('.overlay__text').evaluate((element) => element.scrollHeight)
    const bootstrap = await controls.evaluate(() => window.controlsApi.bootstrap())
    await controls.evaluate((fontSize) => window.controlsApi.updatePreferences({ fontSize: fontSize + 10 }), bootstrap.snapshot.fontSize)
    await expect.poll(() => overlay.locator('.overlay__text').evaluate((element) => element.scrollHeight)).toBeGreaterThan(initialHeight)
    await controls.evaluate(() => window.controlsApi.updatePreferences({ bannerMode: true, targetMode: 'duration', targetDurationSec: 120 }))
    await expect(overlay.locator('.banner__text')).toBeVisible()
    const range = await overlay.locator('.banner__text').evaluate((element) => element.scrollWidth + element.parentElement!.clientWidth)
    await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).snapshot.scrollSpeed).toBeCloseTo(Math.max(1, Math.min(2000, range / 120)), 0)
    await controls.evaluate(() => window.controlsApi.updatePreferences({ bannerMode: false }))
    await expect(overlay.locator('.overlay__text')).toBeVisible()
    await controls.getByRole('button', { name: /Remove untitled-/ }).click()
    const confirmation = controls.getByRole('alertdialog')
    await expect(confirmation).toBeVisible()
    for (let index = 0; index < 4; index += 1) {
      await controls.keyboard.press('Tab')
      expect(await controls.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true)
    }
    await controls.keyboard.press('Escape')
    await expect(confirmation).toBeHidden()
    expect((await controls.evaluate(() => window.controlsApi.bootstrap())).snapshot.documents).toHaveLength(1)
    await stop(application)
  } finally {
    await stop(application).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})


test('real metadata permission failure is visible and a later create can succeed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-e2e-permission-'))
  const application = await launch(directory)
  let metadataDirectory: string | undefined
  let originalMode: number | undefined
  try {
    const controls = await surface(application, 'controls')
    const about = await controls.evaluate(() => window.controlsApi.getAbout())
    metadataDirectory = dirname(about.storePath)
    originalMode = (await stat(metadataDirectory)).mode & 0o777
    await chmod(metadataDirectory, 0o500)
    await controls.getByRole('button', { name: 'New blank script' }).click()
    await expect(controls.getByRole('alert')).toContainText('EACCES')
    expect((await controls.evaluate(() => window.controlsApi.bootstrap())).snapshot.documents).toHaveLength(0)
    await chmod(metadataDirectory, originalMode)
    await controls.getByRole('button', { name: 'New blank script' }).click()
    await expect(controls.getByRole('textbox', { name: /Edit untitled-/ })).toBeVisible()
    expect((await controls.evaluate(() => window.controlsApi.bootstrap())).snapshot.documents).toHaveLength(1)
    await stop(application)
  } finally {
    if (metadataDirectory && originalMode !== undefined) await chmod(metadataDirectory, originalMode)
    await stop(application).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('packaged utility process imports real DOCX and PDF without granting overwrite', async () => {
  const docx = process.env.TELEPROMPT_REAL_DOCX
  const pdf = process.env.TELEPROMPT_REAL_PDF
  if (!docx || !pdf) throw new Error('Set TELEPROMPT_REAL_DOCX and TELEPROMPT_REAL_PDF to real documents for packaged format qualification')
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-e2e-office-'))
  const application = await launch(directory, [docx, pdf])
  try {
    const controls = await surface(application, 'controls')
    await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).snapshot.documents.length).toBe(2)
    const bootstrap = await controls.evaluate(() => window.controlsApi.bootstrap())
    expect(bootstrap.snapshot.documents.map((document) => document.format)).toEqual(['docx', 'pdf'])
    expect(bootstrap.snapshot.documents.every((document) => document.saveMode === 'save-as' && !document.dirty)).toBe(true)
    expect(bootstrap.activeDocument?.content.trim().length).toBeGreaterThan(0)
    await stop(application)
  } finally {
    await test.info().attach('process-output', { body: application.output(), contentType: 'text/plain' })
    await stop(application).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})
