import { expect, test } from '@playwright/test'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { launch, surface, recoveredSurface, stop, readme, security } from './harness.js'

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

test('packaged document delivery skips settings saves and preserves selection and reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-e2e-document-events-'))
  const source = join(directory, 'README.md')
  const secondSource = join(directory, 'SECURITY.md')
  await writeFile(source, readme)
  await writeFile(secondSource, security)
  const application = await launch(directory, [source, secondSource])
  try {
    const controls = await surface(application, 'controls')
    await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).snapshot.documents.length).toBe(2)
    await controls.waitForTimeout(2200)
    const bootstrap = await controls.evaluate(() => window.controlsApi.bootstrap())
    const first = bootstrap.snapshot.documents.find((document) => document.sourcePath === source)!
    const second = bootstrap.snapshot.documents.find((document) => document.sourcePath === secondSource)!
    await controls.evaluate((id) => window.controlsApi.selectDocument(id), second.id)
    await controls.evaluate(() => {
      const events: Array<{ id: string; revision: number; content: string } | null> = []
      Object.assign(window, { observedDocumentEvents: events })
      window.controlsApi.onActiveDocument((document) => events.push(document))
    })
    const events = () => controls.evaluate(() => (window as unknown as {
      observedDocumentEvents: Array<{ id: string; revision: number; content: string } | null>
    }).observedDocumentEvents)
    await controls.evaluate((id) => window.controlsApi.selectDocument(id), first.id)
    await expect.poll(async () => (await events()).at(-1)?.id).toBe(first.id)
    await controls.waitForTimeout(2200)
    const initialEvents = await events()
    const opacity = bootstrap.snapshot.opacity / 2
    // A changed preference and a repeated save of that preference both preserve the body.
    for (let save = 0; save < 2; save += 1) {
      const before = await controls.evaluate(() => window.controlsApi.bootstrap())
      await controls.evaluate((value) => window.controlsApi.updatePreferences({ opacity: value }), opacity)
      await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).storageStatus.lastPersistedAt)
        .toBeGreaterThan(before.storageStatus.lastPersistedAt!)
      // Observe the body channel after the real metadata completion notification.
      await controls.waitForTimeout(200)
      expect(await events()).toEqual(initialEvents)
    }
    await controls.evaluate((id) => window.controlsApi.selectDocument(id), second.id)
    await expect.poll(async () => (await events()).at(-1)?.id).toBe(second.id)
    expect((await events()).at(-1)?.content).toBe(security)
    const selectedRevision = (await events()).at(-1)!.revision
    await copyFile(source, secondSource)
    await controls.evaluate((id) => window.controlsApi.reloadDocument(id), second.id)
    await expect.poll(async () => (await events()).at(-1)?.revision).toBeGreaterThan(selectedRevision)
    expect((await events()).at(-1)?.content).toBe(readme)
  } finally {
    await stop(application).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('packaged importer reads genuine files, selects sources, and reloads external changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-e2e-import-'))
  const source = join(directory, 'README.md')
  const secondSource = join(directory, 'SECURITY.md')
  await writeFile(source, readme)
  await writeFile(secondSource, security)
  const sourceHash = sha256(await readFile(source))
  const secondHash = sha256(await readFile(secondSource))
  let application = await launch(directory, [source, secondSource])
  try {
    let controls = await surface(application, 'controls')
    const overlay = await surface(application, 'overlay')
    await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).snapshot.documents.length).toBe(2)
    const imported = await controls.evaluate(() => window.controlsApi.bootstrap())
    const metadata = imported.snapshot.documents.find((document) => document.sourcePath === source)!
    expect(await controls.evaluate((id) => window.controlsApi.selectDocument(id), metadata.id)).toEqual({ ok: true })
    await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).activeDocument?.content).toBe(readme)
    expect(metadata).toMatchObject({ sourcePath: source, dirty: false, format: 'markdown' })
    const overlayBootstrap = await overlay.evaluate(() => window.overlayApi.bootstrap())
    expect(overlayBootstrap.snapshot.activeDocumentMeta).toMatchObject({ id: metadata.id, format: 'markdown' })
    expect(JSON.stringify(overlayBootstrap.snapshot)).not.toContain(source)
    expect(overlayBootstrap.snapshot).not.toHaveProperty('documents')
    expect(overlayBootstrap.snapshot).not.toHaveProperty('recentFiles')
    await expect(controls.getByLabel('Read-only script text')).toHaveText(readme)
    await expect(overlay.locator('.overlay__text')).toContainText(readme.split('\n')[0].replace(/^#+\s*/, ''))
    await controls.screenshot({ path: test.info().outputPath('controls-read-only.png') })
    await overlay.screenshot({ path: test.info().outputPath('overlay-read-only.png') })
    await controls.locator('.sidebar__list').getByRole('button', { name: 'SECURITY.md', exact: true }).click()
    await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).activeDocument?.content).toBe(security)
    await controls.locator('.sidebar__list').getByRole('button', { name: 'README.md', exact: true }).click()
    await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).activeDocument?.content).toBe(readme)
    expect(sha256(await readFile(source))).toBe(sourceHash)
    expect(sha256(await readFile(secondSource))).toBe(secondHash)

    // A genuine external file replacement: Teleprompt must observe it only on reload.
    await copyFile(secondSource, source)
    expect((await controls.evaluate(() => window.controlsApi.bootstrap())).activeDocument?.content).toBe(readme)
    await controls.getByRole('button', { name: 'Reload source', exact: true }).click()
    await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).activeDocument?.content).toBe(security)
    expect(sha256(await readFile(source))).toBe(secondHash)
    await stop(application)
    application = await launch(directory)
    controls = await surface(application, 'controls')
    await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).activeDocument?.content).toBe(security)
    expect((await controls.evaluate(() => window.controlsApi.bootstrap())).snapshot.documents[0]).toMatchObject({ id: metadata.id, dirty: false })
    expect(sha256(await readFile(source))).toBe(secondHash)
    expect(sha256(await readFile(secondSource))).toBe(secondHash)
  } finally {
    await stop(application).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('packaged surfaces expose read-only playback and deny microphone access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-e2e-read-only-'))
  const source = join(directory, 'README.md')
  await writeFile(source, readme)
  const sourceHash = sha256(await readFile(source))
  let application = await launch(directory, [source])
  try {
    let controls = await surface(application, 'controls')
    let overlay = await surface(application, 'overlay')
    await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).activeDocument?.content).toBe(readme)
    expect(await controls.evaluate(() => ({ controls: typeof window.controlsApi, overlay: typeof window.overlayApi, legacy: typeof (window as unknown as { api?: unknown }).api })))
      .toEqual({ controls: 'object', overlay: 'undefined', legacy: 'undefined' })
    expect(await overlay.evaluate(() => ({ controls: typeof window.controlsApi, overlay: typeof window.overlayApi })))
      .toEqual({ controls: 'undefined', overlay: 'object' })
    const keys = await controls.evaluate(() => Object.keys(window.controlsApi))
    for (const removed of ['createDocument', 'updateDocument', 'saveDocument', 'requestVoice', 'grantVoiceConsent', 'revokeVoiceConsent', 'reportVoiceStatus', 'onFlushRequest', 'acknowledgeFlush']) {
      expect(keys).not.toContain(removed)
    }
    expect(await overlay.evaluate(() => Object.keys(window.overlayApi))).not.toContain('openEditor')
    await expect(controls.locator('textarea, [contenteditable="true"]')).toHaveCount(0)
    await expect(controls.getByRole('button', { name: /^(New blank script|Save|Save As…|Paste|Revoke microphone consent)$/ })).toHaveCount(0)
    await expect(controls.getByRole('checkbox', { name: /Show live editor|Listen and auto-advance/ })).toHaveCount(0)
    const permission = await controls.evaluate(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        for (const track of stream.getTracks()) track.stop()
        return 'granted'
      } catch (error) { return error instanceof DOMException ? error.name : String(error) }
    })
    expect(permission).toBe('NotAllowedError')
    const bootstrap = await controls.evaluate(() => window.controlsApi.bootstrap())
    for (const removed of ['editMode', 'voicePacing', 'voiceConsent', 'voiceStatus', 'voiceError']) {
      expect(bootstrap.snapshot).not.toHaveProperty(removed)
    }
    expect(JSON.stringify(bootstrap.snapshot)).not.toContain(readme)
    await expect(overlay.locator('.overlay__text')).toContainText(readme.split('\n')[0].replace(/^#+\s*/, ''))
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
    await controls.getByRole('checkbox', { name: 'Mirror vertically', exact: true }).click()
    await expect(controls.getByRole('checkbox', { name: 'Mirror vertically', exact: true })).toBeChecked()
    await stop(application)
    application = await launch(directory)
    controls = await surface(application, 'controls')
    overlay = await surface(application, 'overlay')
    const restored = await controls.evaluate(() => window.controlsApi.bootstrap())
    expect(restored.activeDocument?.content).toBe(readme)
    expect(restored.snapshot).toMatchObject({ playing: false, clickerMode: false, drivePresentation: false, mirrorV: true })
    await expect(overlay.locator('.overlay__text')).toContainText(readme.split('\n')[0].replace(/^#+\s*/, ''))
    const crashSession = await controls.context().newCDPSession(controls)
    await crashSession.send('Page.crash').catch(() => undefined)
    controls = await recoveredSurface(application, 'controls')
    const afterRecovery = await controls.evaluate(() => window.controlsApi.bootstrap())
    expect(afterRecovery.activeDocument?.content).toBe(readme)
    expect(afterRecovery.snapshot.playing).toBe(false)
    expect(sha256(await readFile(source))).toBe(sourceHash)
  } finally {
    await stop(application).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
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


test('native Controls close preserves current preferences and read-only document selection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-e2e-close-'))
  const source = join(directory, 'README.md')
  await writeFile(source, readme)
  const sourceHash = sha256(await readFile(source))
  let application = await launch(directory, [source])
  try {
    let controls = await surface(application, 'controls')
    const overlay = await surface(application, 'overlay')
    await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).activeDocument?.content).toBe(readme)
    await controls.getByRole('checkbox', { name: 'Mirror vertically', exact: true }).click()
    await expect(controls.getByRole('checkbox', { name: 'Mirror vertically', exact: true })).toBeChecked()
    await controls.evaluate(() => window.close())
    await expect.poll(() => controls.isClosed()).toBe(true)
    await overlay.evaluate(() => window.overlayApi.focusControls())
    controls = await recoveredSurface(application, 'controls')
    await expect(controls.getByRole('checkbox', { name: 'Mirror vertically', exact: true })).toBeChecked()
    await expect(controls.getByLabel('Read-only script text')).toHaveText(readme)
    await stop(application)
    application = await launch(directory)
    controls = await surface(application, 'controls')
    const restored = await controls.evaluate(() => window.controlsApi.bootstrap())
    expect(restored.snapshot.documents).toHaveLength(1)
    expect(restored.activeDocument?.content).toBe(readme)
    expect(restored.snapshot.mirrorV).toBe(true)
    expect(sha256(await readFile(source))).toBe(sourceHash)
  } finally {
    await test.info().attach('main-process-log', { body: await readFile(join(directory, 'teleprompt', 'logs', 'teleprompt-crash.log')).catch(() => Buffer.alloc(0)), contentType: 'text/plain' })
    await stop(application).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('geometry follows loaded content and settings confirmations trap keyboard focus', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-e2e-layout-'))
  const source = join(directory, 'README.md')
  await writeFile(source, readme)
  const sourceHash = sha256(await readFile(source))
  const application = await launch(directory, [source])
  try {
    const controls = await surface(application, 'controls')
    const overlay = await surface(application, 'overlay')
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
    await controls.getByRole('button', { name: 'Preferences & diagnostics' }).click()
    await controls.getByRole('button', { name: 'Reset preferences', exact: true }).click()
    const confirmation = controls.getByRole('alertdialog')
    await expect(confirmation).toBeVisible()
    for (let index = 0; index < 4; index += 1) {
      await controls.keyboard.press('Tab')
      expect(await controls.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true)
    }
    await controls.keyboard.press('Escape')
    await expect(confirmation).toBeHidden()
    expect((await controls.evaluate(() => window.controlsApi.bootstrap())).snapshot.documents).toHaveLength(1)
    expect(sha256(await readFile(source))).toBe(sourceHash)
  } finally {
    await stop(application).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('real metadata permission failure is visible and later preferences persist', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-e2e-permission-'))
  const source = join(directory, 'README.md')
  await writeFile(source, readme)
  const sourceHash = sha256(await readFile(source))
  const application = await launch(directory, [source])
  let metadataDirectory: string | undefined
  let originalMode: number | undefined
  try {
    const controls = await surface(application, 'controls')
    await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).activeDocument?.content).toBe(readme)
    const about = await controls.evaluate(() => window.controlsApi.getAbout())
    metadataDirectory = dirname(about.storePath)
    originalMode = (await stat(metadataDirectory)).mode & 0o777
    await chmod(metadataDirectory, 0o500)
    await controls.getByRole('checkbox', { name: 'Mirror vertically', exact: true }).click()
    await expect(controls.getByRole('checkbox', { name: 'Mirror vertically', exact: true })).toBeChecked()
    await expect(controls.locator('.banner-warn')).toContainText('EACCES')
    expect((await controls.evaluate(() => window.controlsApi.bootstrap())).activeDocument?.content).toBe(readme)
    await chmod(metadataDirectory, originalMode)
    await controls.getByRole('checkbox', { name: 'Mirror horizontally' }).click()
    await expect(controls.getByRole('checkbox', { name: 'Mirror horizontally' })).toBeChecked()
    await expect.poll(async () => JSON.parse(await readFile(about.storePath, 'utf8')).state.mirrorH).toBe(true)
    await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).storageStatus.lastPersistedAt).toBeGreaterThan(0)
    const savedAt = (await controls.evaluate(() => window.controlsApi.bootstrap())).storageStatus.lastPersistedAt!
    expect(savedAt).toBeCloseTo((await stat(about.storePath)).mtimeMs, 0)
    await expect(controls.getByLabel('Playlist and settings save status').locator('time')).toHaveAttribute('datetime', new Date(savedAt).toISOString())
    expect(sha256(await readFile(source))).toBe(sourceHash)
    await stop(application)
  } finally {
    if (metadataDirectory && originalMode !== undefined) await chmod(metadataDirectory, originalMode)
    await stop(application).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('packaged utility process reads genuine public DOCX and PDF without changing sources', async () => {
  const docx = resolve(process.env.TELEPROMPT_REAL_DOCX ?? 'test/fixtures/public/dwi-privacy-notice.docx')
  const pdf = resolve(process.env.TELEPROMPT_REAL_PDF ?? 'test/fixtures/public/us-constitution.pdf')
  const hashes = await Promise.all([docx, pdf].map(async (path) => sha256(await readFile(path))))
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-e2e-office-'))
  const application = await launch(directory, [docx, pdf])
  try {
    const controls = await surface(application, 'controls')
    const overlay = await surface(application, 'overlay')
    await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).snapshot.documents.length).toBe(2)
    const bootstrap = await controls.evaluate(() => window.controlsApi.bootstrap())
    expect(bootstrap.snapshot.documents.map((document) => document.format)).toEqual(['docx', 'pdf'])
    expect(bootstrap.snapshot.documents.every((document) => !document.dirty)).toBe(true)
    for (const document of bootstrap.snapshot.documents) {
      expect(await controls.evaluate((id) => window.controlsApi.selectDocument(id), document.id)).toEqual({ ok: true })
      await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).activeDocument?.id).toBe(document.id)
      const content = (await controls.evaluate(() => window.controlsApi.bootstrap())).activeDocument!.content
      expect(content.trim().length).toBeGreaterThan(0)
      await expect(controls.getByLabel('Read-only script text')).toHaveText(content.slice(0, 32_768))
      await expect.poll(async () => (await overlay.evaluate(() => window.overlayApi.bootstrap())).activeDocument?.content).toBe(content)
      if (content.length > 32_768) {
        await expect(controls.getByText('Preview shows the first 32,768 characters. The overlay plays the full script.')).toBeVisible()
      }
    }
    expect(await Promise.all([docx, pdf].map(async (path) => sha256(await readFile(path))))).toEqual(hashes)
  } finally {
    await test.info().attach('process-output', { body: application.output(), contentType: 'text/plain' })
    await stop(application).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})
