import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { DocumentFormat, DocumentRecord } from '../../shared/contracts.js'
import { saveTextAtomically } from '../files/atomic-write.js'
import { classifyDocumentPath, isLosslessTextFormat } from '../files/file-policy.js'
import { readBoundedRegularFile } from '../files/safe-reader.js'

export type SaveDocumentResult =
  | {
      ok: true
      targetPath: string
      format: Extract<DocumentFormat, 'text' | 'markdown' | 'fountain'>
      sourceMtimeMs: number
      sourceHash: string
    }
  | {
      ok: false
      reason:
        | 'save-as-required'
        | 'unsupported-target'
        | 'conflict'
        | 'invalid-target'
        | 'write-failed'
      error?: string
    }

export class DocumentSaveService {
  constructor(private readonly maxSourceBytes = 10 * 1024 * 1024) {}

  async save(document: DocumentRecord, requestedTargetPath?: string): Promise<SaveDocumentResult> {
    if (!requestedTargetPath && document.saveMode === 'save-as') {
      return { ok: false, reason: 'save-as-required' }
    }
    const targetPath = requestedTargetPath ?? document.sourcePath
    if (!targetPath || !isAbsolute(targetPath)) return { ok: false, reason: 'invalid-target' }
    const targetFormat = classifyDocumentPath(targetPath)
    if (!targetFormat || !isLosslessTextFormat(targetFormat)) {
      return { ok: false, reason: 'unsupported-target' }
    }

    let expectedMtimeMs: number | null | undefined
    const inPlace = requestedTargetPath === undefined
    if (inPlace) {
      if (!document.sourcePath || !document.sourceHash) return { ok: false, reason: 'conflict' }
      try {
        const current = await readBoundedRegularFile(document.sourcePath, this.maxSourceBytes)
        const currentHash = sha(current.bytes)
        if (currentHash !== document.sourceHash) return { ok: false, reason: 'conflict' }
        expectedMtimeMs = document.sourceMtimeMs
      } catch (error) {
        return {
          ok: false,
          reason: 'conflict',
          error: error instanceof Error ? error.message : 'unable to verify source',
        }
      }
    }

    const saved = await saveTextAtomically({
      targetPath,
      content: document.content,
      expectedMtimeMs,
    })
    if (!saved.ok) {
      if (saved.reason === 'conflict') return { ok: false, reason: 'conflict' }
      if (saved.reason === 'invalid-target') {
        return { ok: false, reason: 'invalid-target', error: saved.error }
      }
      return { ok: false, reason: 'write-failed', error: saved.error }
    }
    const canonicalPath = await realpath(targetPath)
    return {
      ok: true,
      targetPath: canonicalPath,
      format: targetFormat as Extract<DocumentFormat, 'text' | 'markdown' | 'fountain'>,
      sourceMtimeMs: saved.mtimeMs,
      sourceHash: sha(Buffer.from(document.content, 'utf8')),
    }
  }
}

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
