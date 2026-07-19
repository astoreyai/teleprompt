import { join } from 'node:path'
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses'

export default async function hardenPackagedElectron(context) {
  const extension = { darwin: '.app', mas: '.app', win32: '.exe', linux: '' }[
    context.electronPlatformName
  ]
  if (extension === undefined) throw new Error(`unsupported Electron platform: ${context.electronPlatformName}`)
  const executableName =
    context.electronPlatformName === 'linux'
      ? context.packager.executableName
      : context.packager.appInfo.productFilename
  const executablePath = join(context.appOutDir, `${executableName}${extension}`)
  await flipFuses(executablePath, {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    resetAdHocDarwinSignature: context.electronPlatformName === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // Electron's stock Linux distribution does not ship browser_v8_context_snapshot.bin.
    // Enabling this fuse without that asset aborts before app startup.
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.WasmTrapHandlers]: true,
  })
}
