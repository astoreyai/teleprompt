import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

// Execute the same native-process qualification from the unit gate. This runs
// production Electron utility workers with genuine public documents, including
// kernel SIGSTOP/SIGKILL. No fake IPC messages, worker handles, or timers.
// Malformed/oversized *protocol responses* remain an explicit coverage gap:
// the production worker rejects output before it can emit such a response.
it('qualifies supervisor outcomes against actual Electron utility processes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teleprompt-supervisor-native-'))
  try {
    const { stdout } = await promisify(execFile)('xvfb-run', ['-a',
      resolve('node_modules/.bin/playwright'), 'test', 'e2e/parser-resource.spec.ts',
      '--retries=0', '--reporter=json', `--output=${directory}`], {
      cwd: process.cwd(),
      env: { ...process.env,
        TELEPROMPT_REAL_PDF: resolve('test/fixtures/public/us-constitution.pdf'),
        TELEPROMPT_REAL_DOCX: resolve('test/fixtures/public/dwi-privacy-notice.docx') },
      timeout: 45_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    const report = JSON.parse(stdout)
    expect(report.stats.unexpected).toBe(0)
    expect(report.stats.skipped).toBe(0)
    expect(report.stats.flaky).toBe(0)
    expect(report.stats.expected).toBe(7)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
