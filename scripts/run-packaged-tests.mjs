import { spawnSync } from 'node:child_process'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const environment = { ...process.env }
if (!environment.TELEPROMPT_REAL_DOCX || !environment.TELEPROMPT_REAL_PDF) {
  throw new Error('Packaged tests require TELEPROMPT_REAL_DOCX and TELEPROMPT_REAL_PDF to name genuine local documents')
}
function run(command, args) {
  const child = spawnSync(command, args, { env: environment, stdio: 'inherit' })
  if (child.error) throw child.error
  if (child.status !== 0) process.exit(child.status ?? 1)
}
// Reuse an already-configured helper only after inspecting it. Never modify native ownership.
if (!environment.CHROME_DEVEL_SANDBOX) {
  const helper = resolve('release/linux-unpacked/chrome-sandbox')
  const info = await stat(helper).catch(() => null)
  if (info?.isFile() && info.uid === 0 && info.gid === 0 && (info.mode & 0o7777) === 0o4755) {
    environment.CHROME_DEVEL_SANDBOX = helper
  }
}
if (!environment.TELEPROMPT_E2E_EXECUTABLE) {
  const output = await mkdtemp(join(tmpdir(), 'teleprompt-packaged-'))
  run(resolve('node_modules/.bin/electron-vite'), ['build'])
  run(resolve('node_modules/.bin/electron-builder'), ['--linux', '--dir', `--config.directories.output=${output}`])
  environment.TELEPROMPT_E2E_EXECUTABLE = join(output, 'linux-unpacked', 'teleprompt')
  process.stdout.write(`Retained review artifact: ${output}\n`)
}
run(process.execPath, ['scripts/verify-artifact.mjs', dirname(resolve(environment.TELEPROMPT_E2E_EXECUTABLE))])
run('xvfb-run', ['-a', 'sh', '-c', 'ulimit -c 0; export TELEPROMPT_TEST_DISPLAY="$DISPLAY"; exec "$@"', 'teleprompt-tests',
  resolve('node_modules/.bin/playwright'), 'test', ...process.argv.slice(2)])
