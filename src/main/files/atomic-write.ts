import { createHash, randomUUID } from 'node:crypto'
import { open, lstat, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { MAX_DOCUMENT_BYTES } from '../../shared/text.js'
import { readBoundedRegularFile } from './safe-reader.js'

export type AtomicWriteResult =
  | { ok: true; mtimeMs: number }
  | { ok: false; reason: 'conflict'; currentMtimeMs: number | null }
  | { ok: false; reason: 'invalid-target'; error: string }
  | { ok: false; reason: 'write-failed'; error: string }

export async function saveTextAtomically(input: {
  targetPath: string
  content: string
  expectedMtimeMs?: number | null
  expectedSourceHash?: string
}): Promise<AtomicWriteResult> {
  if (!input.targetPath || typeof input.content !== 'string') {
    return { ok: false, reason: 'invalid-target', error: 'invalid save request' }
  }

  const current = await inspectTarget(input.targetPath)
  if (current.kind === 'invalid') {
    return { ok: false, reason: 'invalid-target', error: current.error }
  }
  if (
    input.expectedMtimeMs !== undefined &&
    input.expectedMtimeMs !== null &&
    (current.kind === 'missing' || Math.abs(current.mtimeMs - input.expectedMtimeMs) > 1)
  ) {
    return {
      ok: false,
      reason: 'conflict',
      currentMtimeMs: current.kind === 'file' ? current.mtimeMs : null,
    }
  }

  const parent = dirname(input.targetPath)
  const temporaryPath = join(
    parent,
    `.${basename(input.targetPath)}.teleprompt-${process.pid}-${randomUUID()}.tmp`,
  )
  let temporaryCreated = false

  try {
    const file = await open(temporaryPath, 'wx', current.kind === 'file' ? current.mode : 0o600)
    temporaryCreated = true
    try {
      await file.writeFile(input.content, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    // Revalidate after writing/fsyncing the temporary file. This narrows the
    // external-writer window; portable rename is not a compare-and-swap.
    if (input.expectedSourceHash !== undefined) {
      try {
        const source = await readBoundedRegularFile(input.targetPath, MAX_DOCUMENT_BYTES)
        if (createHash('sha256').update(source.bytes).digest('hex') !== input.expectedSourceHash) {
          return { ok: false, reason: 'conflict', currentMtimeMs: source.mtimeMs }
        }
      } catch {
        return { ok: false, reason: 'conflict', currentMtimeMs: null }
      }
    }
    const latest = await inspectTarget(input.targetPath)
    if (latest.kind === 'invalid') return { ok: false, reason: 'invalid-target', error: latest.error }
    if (latest.kind !== current.kind || (latest.kind === 'file' && current.kind === 'file' &&
      (latest.dev !== current.dev || latest.ino !== current.ino || latest.ctimeMs !== current.ctimeMs ||
       latest.mtimeMs !== current.mtimeMs || latest.size !== current.size))) {
      return { ok: false, reason: 'conflict', currentMtimeMs: latest.kind === 'file' ? latest.mtimeMs : null }
    }
    await rename(temporaryPath, input.targetPath)
    temporaryCreated = false
    await syncDirectory(parent)
    const saved = await lstat(input.targetPath)
    return { ok: true, mtimeMs: saved.mtimeMs }
  } catch (error) {
    return {
      ok: false,
      reason: 'write-failed',
      error: error instanceof Error ? error.message : 'write failed',
    }
  } finally {
    if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined)
  }
}

type InspectedTarget =
  | { kind: 'missing' }
  | { kind: 'file'; mtimeMs: number; ctimeMs: number; mode: number; dev: number; ino: number; size: number }
  | { kind: 'invalid'; error: string }

async function inspectTarget(path: string): Promise<InspectedTarget> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) return { kind: 'invalid', error: 'refusing to overwrite a symbolic link' }
    if (!info.isFile()) return { kind: 'invalid', error: 'target is not a regular file' }
    return { kind: 'file', mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, mode: info.mode, dev: info.dev, ino: info.ino, size: info.size }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { kind: 'missing' }
    return {
      kind: 'invalid',
      error: error instanceof Error ? error.message : 'unable to inspect target',
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const directory = await open(path, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch {
    // The file has already been durably synced. Some filesystems do not allow
    // directory fsync, so this final durability enhancement is best-effort.
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
