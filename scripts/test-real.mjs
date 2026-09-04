import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const suites = [
  'src/main/application/app-store.test.ts',
  'src/main/application/app-store.real.test.ts',
  'src/main/application/controller.test.ts',
  'src/main/domain/workspace.test.ts',
  'src/main/persistence/repositories.test.ts',
  'src/main/documents/import-service.test.ts',
  'src/main/lifecycle/recovery-policy.test.ts',
  'src/main/parser/core.real.test.ts',
  'src/main/parser/archive.real.test.ts',
  'src/main/parser/zip-policy.test.ts',
  'src/main/files/atomic-write.test.ts',
  'src/main/files/safe-reader.test.ts',
  'src/main/files/file-policy.test.ts',
  'src/main/platform/ipc-policy.test.ts',
  'src/main/platform/renderer-route.test.ts',
  'src/main/platform/overlay-projection.test.ts',
  'src/renderer/src/shared/checkpoint-gate.test.ts',
  'src/renderer/src/shared/render-policy.test.ts',
  'src/renderer/src/shared/voice.test.ts',
]
const paths = ['README.md', 'SECURITY.md', 'src/renderer/controls.html', 'build/icon.png',
  'node_modules/typescript/lib/typescript.d.ts', process.env.TELEPROMPT_REAL_DOCX, process.env.TELEPROMPT_REAL_PDF].filter(Boolean)
const provenance = await Promise.all(paths.map(async (path) => {
  const [bytes, info] = await Promise.all([readFile(path), stat(path)])
  return { path: resolve(path), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    mtime: info.mtime.toISOString(), transformation: 'Unmodified bytes; individual tests use temporary copies or explicit byte-limit parameters.' }
}))
const evidenceDirectory = process.env.TELEPROMPT_TEST_EVIDENCE
if (evidenceDirectory) {
  await mkdir(evidenceDirectory, { recursive: true })
  await writeFile(resolve(evidenceDirectory, 'real-input-provenance.json'), JSON.stringify({ provenance, suites }, null, 2) + '\n')
}
process.stdout.write('Running the reviewed real-input subset. This is not full release qualification.\n')
process.stdout.write('Legacy schema, cue/text, parser-worker, save-service, diagnostic and presentation suites still require conversion; see IMPLEMENTATION_STATUS.md.\n')
if (!process.env.TELEPROMPT_REAL_DOCX || !process.env.TELEPROMPT_REAL_PDF) {
  process.stderr.write('Real DOCX/PDF corpus is missing. Set TELEPROMPT_REAL_DOCX and TELEPROMPT_REAL_PDF; refusing a silently skipped format gate.\n')
  process.exit(2)
}
const child = spawnSync(resolve('node_modules/.bin/vitest'), ['run', ...suites, ...process.argv.slice(2)], { stdio: 'inherit' })
if (child.error) throw child.error
process.exit(child.status ?? 1)
