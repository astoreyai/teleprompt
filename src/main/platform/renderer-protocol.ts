import { net, protocol } from 'electron'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolveRendererRequestPath } from './renderer-route.js'

const moduleDirectory = fileURLToPath(new URL('.', import.meta.url))
const rendererDirectory = join(moduleDirectory, '../renderer')
let registered = false
let installed = false

export function registerRendererScheme(): void {
  if (registered) return
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'teleprompt',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
        stream: true,
      },
    },
  ])
  registered = true
}

export function installRendererProtocol(): void {
  if (installed) return
  protocol.handle('teleprompt', (request) => {
    const target = resolveRendererRequestPath(rendererDirectory, request.url)
    if (!target) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(target).toString())
  })
  installed = true
}
