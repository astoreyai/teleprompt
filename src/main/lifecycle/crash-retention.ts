import { constants } from 'node:fs'
import { lstat, open, readdir, unlink, type FileHandle } from 'node:fs/promises'
import { resolve } from 'node:path'

export type CrashRetentionOptions = {
  now?: number
  maxAgeMs?: number
  maxArtifacts?: number
  maxDepth?: number
}

const CRASH_ARTIFACT = /\.(dmp|meta|json|txt)$/i
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW

export async function purgeOldCrashArtifacts(directory: string, options: CrashRetentionOptions = {}): Promise<void> {
  // The shipped platform is Linux. Without descriptor-relative paths, defer this
  // optional cleanup instead of falling back to a race-prone pathname walk.
  if (process.platform !== 'linux') return
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000
  const maxArtifacts = options.maxArtifacts ?? 10
  const maxDepth = options.maxDepth ?? 2
  const held: FileHandle[] = []
  const files: Array<{ path: string; mtimeMs: number }> = []
  const descriptorPath = (directory: FileHandle) => `/proc/self/fd/${directory.fd}`

  const walk = async (handle: FileHandle, depth: number): Promise<void> => {
    let entries
    try { entries = await readdir(descriptorPath(handle), { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const child = `${descriptorPath(handle)}/${entry.name}`
      try {
        if (entry.isDirectory() && depth < maxDepth && held.length < 128) {
          const nested = await open(child, DIRECTORY_FLAGS)
          held.push(nested)
          await walk(nested, depth + 1)
        } else if (entry.isFile() && CRASH_ARTIFACT.test(entry.name)) {
          const info = await lstat(child)
          if (info.isFile()) files.push({ path: child, mtimeMs: info.mtimeMs })
        }
      } catch {
        // Concurrent replacement, links, and unavailable entries are deferred.
      }
    }
  }

  let root: FileHandle | undefined
  try {
    // Pin every ancestor too: no untrusted pathname component can redirect a
    // later open. Each new directory is opened relative to its held parent.
    root = await open('/', DIRECTORY_FLAGS)
    for (const component of resolve(directory).split('/').filter(Boolean)) {
      const next = await open(`${descriptorPath(root)}/${component}`, DIRECTORY_FLAGS)
      await root.close()
      root = next
    }
    held.push(root)
    root = undefined
    await walk(held[0], 0)
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const cutoff = now - maxAgeMs
    for (const [index, file] of files.entries()) {
      if (index >= maxArtifacts || file.mtimeMs < cutoff) await unlink(file.path).catch(() => undefined)
    }
  } catch {
    // Crash retention is best effort; inaccessible directories never block startup.
  } finally {
    await root?.close().catch(() => undefined)
    await Promise.all(held.map(handle => handle.close().catch(() => undefined)))
  }
}
