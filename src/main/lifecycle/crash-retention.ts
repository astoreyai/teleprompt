import { readdir, stat, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

export type CrashRetentionOptions = {
  now?: number
  maxAgeMs?: number
  maxArtifacts?: number
  maxDepth?: number
}

const CRASH_ARTIFACT = /\.(dmp|meta|json|txt)$/i

export async function purgeOldCrashArtifacts(
  directory: string,
  options: CrashRetentionOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000
  const maxArtifacts = options.maxArtifacts ?? 10
  const maxDepth = options.maxDepth ?? 2
  const files: Array<{ path: string; mtimeMs: number }> = []

  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = resolve(path, entry.name)
      if (entry.isDirectory()) {
        await walk(child, depth + 1)
      } else if (entry.isFile() && CRASH_ARTIFACT.test(entry.name)) {
        try {
          files.push({ path: child, mtimeMs: (await stat(child)).mtimeMs })
        } catch {
          // The artifact disappeared while it was being inspected.
        }
      }
    }
  }

  await walk(directory, 0)
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const cutoff = now - maxAgeMs
  await Promise.all(
    files
      .filter((file, index) => index >= maxArtifacts || file.mtimeMs < cutoff)
      .map((file) => unlink(file.path).catch(() => undefined)),
  )
}
