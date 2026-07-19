import { resolve, sep } from 'node:path'

export function resolveRendererRequestPath(rootDirectory: string, requestUrl: string): string | null {
  try {
    if (/%(?:2e|2f|5c)/i.test(requestUrl)) return null
    const url = new URL(requestUrl)
    if (url.protocol !== 'teleprompt:' || url.hostname !== 'app' || url.username || url.password || url.port) {
      return null
    }
    const decodedPath = decodeURIComponent(url.pathname)
    if (decodedPath.includes('\0') || decodedPath.includes('\\')) return null
    const root = resolve(rootDirectory)
    const target = resolve(root, decodedPath.replace(/^\/+/, ''))
    return target === root || target.startsWith(`${root}${sep}`) ? target : null
  } catch {
    return null
  }
}
