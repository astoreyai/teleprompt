import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

process.env.TELEPROMPT_REAL_DOCX ??= resolve('test/fixtures/public/dwi-privacy-notice.docx')
process.env.TELEPROMPT_REAL_PDF ??= resolve('test/fixtures/public/us-constitution.pdf')
process.env.TELEPROMPT_REAL_LEGACY_PROFILE ??= resolve('test/fixtures/public/legacy-1.0.3')

const suites = [
  'src/main/application/app-store.test.ts',
  'src/main/application/startup.real.test.ts',
  'src/main/application/app-store.real.test.ts',
  'src/main/application/controller.test.ts',
  'src/main/domain/workspace.test.ts',
  'src/main/persistence/repositories.test.ts',
  'src/main/persistence/repositories-legacy.real.test.ts',
  'src/main/persistence/schema.test.ts',
  'src/main/documents/import-service.test.ts',
  'src/main/diagnostic-log.test.ts',
  'src/main/lifecycle/crash-retention.real.test.ts',
  'src/main/lifecycle/crash-race.real.test.ts',
  'src/main/lifecycle/crash-retention.test.ts',
  'src/main/lifecycle/recovery-policy.test.ts',
  'src/main/parser/core.real.test.ts',
  'src/main/parser/parser-core.test.ts',
  'src/main/parser/supervisor.test.ts',
  'src/main/parser/pdf-budget.real.test.ts',
  'src/main/parser/archive.real.test.ts',
  'src/main/parser/zip-policy.test.ts',
  'src/main/files/atomic-write.test.ts',
  'src/main/files/safe-reader.test.ts',
  'src/main/files/file-policy.test.ts',
  'src/main/platform/ipc-policy.test.ts',
  'src/main/platform/renderer-route.test.ts',
  'src/main/platform/overlay-projection.test.ts',
  'src/main/presentation.test.ts',
  'src/shared/cues.test.ts',
  'src/shared/text.test.ts',
  'src/renderer/src/shared/checkpoint-gate.test.ts',
  'src/renderer/src/shared/render-policy.test.ts',
]
const paths = ['README.md', 'SECURITY.md', 'src/renderer/controls.html', 'build/icon.png',
  'test/fixtures/github-checkout-token.log', 'test/fixtures/public/provenance.json',
  'test/fixtures/public/nasa-atom-alaska.srt', 'test/fixtures/public/nasa-atom-alaska.vtt',
  'test/fixtures/public/legacy-0.1.0/teleprompt-state.json',
  'test/fixtures/public/localization/provenance.json',
  'test/fixtures/public/localization/ar-cancel.txt', 'test/fixtures/public/localization/he-cancel.txt',
  'node_modules/typescript/lib/fr/diagnosticMessages.generated.json',
  'node_modules/typescript/lib/ru/diagnosticMessages.generated.json',
  'node_modules/typescript/lib/typescript.d.ts', process.env.TELEPROMPT_REAL_DOCX, process.env.TELEPROMPT_REAL_PDF].filter(Boolean)
for (const corpus of [process.env.TELEPROMPT_REAL_CRASH_CORPUS, process.env.TELEPROMPT_REAL_LEGACY_PROFILE].filter(Boolean)) {
  const manifest = resolve(corpus, 'provenance.json')
  paths.push(manifest)
  const captured = JSON.parse(await readFile(manifest, 'utf8'))
  for (const artifact of captured.artifacts) {
    paths.push(resolve(corpus, artifact.name))
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
process.stdout.write('Running the reviewed real-input suites. Full coverage and native release acceptance remain separate gates.\n')
process.stdout.write('Run scripts/check-release-qualification.mjs to verify reviewed suite hashes; see docs/audits/2026-09-04/REAL_INPUT_QUALIFICATION.md for corpus and coverage limitations.\n')
if (!process.env.TELEPROMPT_REAL_DOCX || !process.env.TELEPROMPT_REAL_PDF || !process.env.TELEPROMPT_REAL_CRASH_CORPUS) {
  process.stderr.write('Set TELEPROMPT_REAL_CRASH_CORPUS to genuine native recovery-test output. DOCX/PDF default to captured public documents; refusing missing genuine input.\n')
  process.exit(2)
}
const child = spawnSync(resolve('node_modules/.bin/vitest'), ['run', ...suites, ...process.argv.slice(2)], { stdio: 'inherit' })
if (child.error) throw child.error
process.exit(child.status ?? 1)
