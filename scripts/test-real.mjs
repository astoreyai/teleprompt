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
  'src/main/diagnostic-log.test.ts',
  'src/main/lifecycle/crash-retention.real.test.ts',
  'src/main/lifecycle/crash-retention.test.ts',
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
  'test/fixtures/github-checkout-token.log',
  'node_modules/typescript/lib/typescript.d.ts', process.env.TELEPROMPT_REAL_DOCX, process.env.TELEPROMPT_REAL_PDF].filter(Boolean)
if (process.env.TELEPROMPT_REAL_CRASH_CORPUS) {
  const manifest = resolve(process.env.TELEPROMPT_REAL_CRASH_CORPUS, 'provenance.json')
  paths.push(manifest)
  const captured = JSON.parse(await readFile(manifest, 'utf8'))
  for (const artifact of captured.artifacts) {
    paths.push(resolve(process.env.TELEPROMPT_REAL_CRASH_CORPUS, artifact.name))
  }
}
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
process.stdout.write('Run scripts/check-release-qualification.mjs for the remaining unreviewed suites; see IMPLEMENTATION_STATUS.md for corpus and coverage limitations.\n')
if (!process.env.TELEPROMPT_REAL_DOCX || !process.env.TELEPROMPT_REAL_PDF || !process.env.TELEPROMPT_REAL_CRASH_CORPUS) {
  process.stderr.write('Set TELEPROMPT_REAL_DOCX, TELEPROMPT_REAL_PDF, and TELEPROMPT_REAL_CRASH_CORPUS to genuine local inputs; refusing an incomplete qualification subset.\n')
  process.exit(2)
}
const child = spawnSync(resolve('node_modules/.bin/vitest'), ['run', ...suites, ...process.argv.slice(2)], { stdio: 'inherit' })
if (child.error) throw child.error
process.exit(child.status ?? 1)
