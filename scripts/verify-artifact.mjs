import { constants } from 'node:fs'
import { access, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses'

const appDirectory = resolve(process.argv[2] ?? 'release/linux-unpacked')
const entries = await readdir(appDirectory, { withFileTypes: true })
const candidates = []
for (const entry of entries) {
  if (!entry.isFile()) continue
  const path = join(appDirectory, entry.name)
  try {
    await access(path, constants.X_OK)
    const info = await stat(path)
    if (info.size > 10_000_000) candidates.push(path)
  } catch {
    // Not an executable candidate.
  }
}
if (candidates.length !== 1) {
  throw new Error(`expected one Electron executable in ${appDirectory}, found ${candidates.length}`)
}

const wire = await getCurrentFuseWire(candidates[0])
const expected = new Map([
  [FuseV1Options.RunAsNode, FuseState.DISABLE],
  [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
  [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
  [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
  [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
  [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE],
])
for (const [fuse, state] of expected) {
  if (wire[fuse] !== state) throw new Error(`fuse ${FuseV1Options[fuse]} is not in the required state`)
}

await access(join(appDirectory, 'resources', 'app.asar'), constants.R_OK)
await access(join(appDirectory, 'LICENSE.teleprompt.txt'), constants.R_OK)
try {
  await access(join(appDirectory, 'resources', 'app'), constants.F_OK)
  throw new Error('unpacked resources/app directory defeats OnlyLoadAppFromAsar')
} catch (error) {
  if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error
}

process.stdout.write(`artifact verified: ${candidates[0]}\n`)
