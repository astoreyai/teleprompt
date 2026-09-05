import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { launch, surface, stop } from './harness.js'
import { observeRendererSandboxes, processTreeMemory } from './process-memory.js'

for (const restart of [false, true]) {
  test(`large-to-small ${restart ? 'restored' : 'new'} file selections release unused memory and preserve source bytes`, async () => {
    test.setTimeout(60_000)
    const directory = await mkdtemp(join(tmpdir(), 'teleprompt-memory-'))
    const originals = ['node_modules/typescript/lib/typescript.js', 'node_modules/typescript/lib/typescript.d.ts', 'README.md', 'SECURITY.md'].map(path => resolve(path))
    const inputs = await Promise.all(originals.map(async (path) => {
      const bytes = await readFile(path)
      const info = await stat(path)
      const copy = join(directory, `${basename(path)}.txt`)
      await copyFile(path, copy)
      return { name: basename(path), original: path, path: copy, length: bytes.toString('utf8').length,
        bytes: bytes.length, mtime: info.mtime.toISOString(), sha256: createHash('sha256').update(bytes).digest('hex') }
    }))
    let app = await launch(directory, inputs.map(input => input.path))
    try {
      let controls = await surface(app, 'controls')
      let overlay = await surface(app, 'overlay')
      await expect.poll(async () => (await controls.evaluate(() => window.controlsApi.bootstrap())).snapshot.documents.length, { timeout: 30_000 }).toBe(inputs.length)
      const documents = (await controls.evaluate(() => window.controlsApi.bootstrap())).snapshot.documents
      const large = documents.find(document => document.sourcePath === inputs[0].path)!
      const small = documents.find(document => document.sourcePath === inputs[2].path)!
      expect((await controls.evaluate(id => window.controlsApi.selectDocument(id), large.id)).ok).toBe(true)
      await expect.poll(() => overlay.locator('.overlay__text').evaluate(element => element.textContent?.length), { timeout: 15_000 }).toBe(inputs[0].length)
      if (restart) {
        await stop(app)
        app = await launch(directory)
        controls = await surface(app, 'controls')
        overlay = await surface(app, 'overlay')
        await expect.poll(() => overlay.locator('.overlay__text').evaluate(element => element.textContent?.length), { timeout: 15_000 }).toBe(inputs[0].length)
        expect((await controls.evaluate(() => window.controlsApi.bootstrap())).snapshot.activeDocumentId).toBe(large.id)
      }
      expect((await controls.evaluate(id => window.controlsApi.selectDocument(id), small.id)).ok).toBe(true)
      await expect.poll(() => overlay.locator('.overlay__text').evaluate(element => element.textContent?.length)).toBe(inputs[2].length)
      let measured = 0
      await expect.poll(async () => {
        const processes = await processTreeMemory(app.process.pid!)
        expect(processes.length).toBeGreaterThan(0)
        measured = processes.reduce((sum, process) => sum + process.privateBytes, 0)
        return measured
      }, { timeout: 15_000, message: 'private memory falls below 512 MiB after leaving the 9 MB file' }).toBeLessThan(512 * 1024 * 1024)
      const sandboxes = await observeRendererSandboxes(app.process.pid!)
      expect(sandboxes.renderers.map(renderer => renderer.role).sort()).toEqual(['controls', 'overlay'])
      for (const renderer of sandboxes.renderers) {
        expect(renderer).toMatchObject({ seccomp: 2, noNewPrivs: 1,
          separateUserNamespace: true, separatePidNamespace: true })
      }
      for (const input of inputs) {
        expect(createHash('sha256').update(await readFile(input.path)).digest('hex')).toBe(input.sha256)
        expect(createHash('sha256').update(await readFile(input.original)).digest('hex')).toBe(input.sha256)
      }
      await test.info().attach('selection-memory', { contentType: 'application/json', body: JSON.stringify({
        restart, privateBytesAfterSmallSelection: measured, sandboxes,
        inputs: inputs.map(({ original, path, ...provenance }) => provenance),
      }) })
      await stop(app)
    } finally {
      await stop(app).catch(() => undefined)
      if (app.process.exitCode === null && app.process.signalCode === null) app.process.kill('SIGKILL')
      await rm(directory, { recursive: true, force: true })
    }
  })
}
