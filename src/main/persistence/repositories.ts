import { mkdir, rename, unlink } from 'node:fs/promises'
import { extname, join, parse } from 'node:path'
import { saveTextAtomically } from '../files/atomic-write.js'
import { readBoundedRegularFile } from '../files/safe-reader.js'
import {
  parsePersistedState,
  type ParsedPersistedState,
  type PersistedStateV2,
} from './schema.js'

const DEFAULT_METADATA_LIMIT = 1024 * 1024
const DOCUMENT_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/

export class MetadataRepository {
  readonly path: string
  private readonly backupPath: string
  private readonly legacyPath: string | null
  private readonly maxBytes: number

  constructor(options: {
    directory: string
    fileName?: string
    legacyFileName?: string
    maxBytes?: number
  }) {
    this.path = join(options.directory, options.fileName ?? 'teleprompt-state.v2.json')
    this.backupPath = `${this.path}.bak`
    this.legacyPath = options.legacyFileName ? join(options.directory, options.legacyFileName) : null
    this.maxBytes = options.maxBytes ?? DEFAULT_METADATA_LIMIT
  }

  async load(): Promise<{
    parsed: ParsedPersistedState
    source: 'primary' | 'backup' | 'legacy' | 'default'
  }> {
    await this.initializeDirectory()
    const candidates: Array<{
      path: string
      source: 'primary' | 'backup' | 'legacy'
    }> = [
      { path: this.path, source: 'primary' },
      { path: this.backupPath, source: 'backup' },
      ...(this.legacyPath ? [{ path: this.legacyPath, source: 'legacy' as const }] : []),
    ]
    const recoveryIssues: string[] = []
    for (const candidate of candidates) {
      const inspected = await inspectRegularFile(candidate.path, this.maxBytes)
      if (inspected.kind === 'missing') continue
      if (inspected.kind === 'invalid') {
        recoveryIssues.push(`${candidate.source} state rejected: ${inspected.error}`)
        await this.quarantine(candidate.path)
        continue
      }
      let raw: unknown
      try {
        raw = JSON.parse(inspected.bytes.toString('utf8'))
      } catch (error) {
        recoveryIssues.push(
          `${candidate.source} state JSON rejected: ${error instanceof Error ? error.message : 'parse failed'}`,
        )
        await this.quarantine(candidate.path)
        continue
      }
      const parsed = parsePersistedState(raw)
      if (parsed.quarantined) {
        recoveryIssues.push(...parsed.issues.map((issue) => `${candidate.source} state rejected: ${issue}`))
        await this.quarantine(candidate.path)
        continue
      }
      if (candidate.source === 'backup') parsed.issues.unshift('recovered state from backup')
      parsed.issues.unshift(...recoveryIssues)
      return { parsed, source: candidate.source }
    }
    const parsed = parsePersistedState(null)
    if (recoveryIssues.length > 0) {
      parsed.quarantined = true
      parsed.issues = recoveryIssues
    }
    return { parsed, source: 'default' }
  }

  async save(value: PersistedStateV2): Promise<void> {
    await this.initializeDirectory()
    const serialized = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(serialized) > this.maxBytes) throw new Error('state metadata too large')

    const current = await readCurrentText(this.path, this.maxBytes)
    if (current) {
      const backup = await saveTextAtomically({ targetPath: this.backupPath, content: current.text })
      if (!backup.ok) throw new Error(`state backup failed: ${resultMessage(backup)}`)
    }
    const saved = await saveTextAtomically({
      targetPath: this.path,
      content: serialized,
      expectedMtimeMs: current?.mtimeMs,
    })
    if (!saved.ok) throw new Error(`state save failed: ${resultMessage(saved)}`)
  }

  private async initializeDirectory(): Promise<void> {
    await mkdir(parse(this.path).dir, { recursive: true, mode: 0o700 })
  }

  private async quarantine(path: string): Promise<void> {
    const extension = extname(path)
    const base = path.slice(0, path.length - extension.length)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await rename(path, `${base}.quarantine-${stamp}${extension || '.json'}`).catch(() => undefined)
  }
}

export class DraftRepository {
  constructor(
    private readonly directory: string,
    private readonly maxBytes = 10 * 1024 * 1024,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
  }

  async write(id: string, content: string): Promise<void> {
    validateDocumentId(id)
    if (Buffer.byteLength(content) > this.maxBytes) throw new Error('draft too large')
    await this.initialize()
    const result = await saveTextAtomically({ targetPath: this.pathFor(id), content })
    if (!result.ok) throw new Error(`draft write failed: ${resultMessage(result)}`)
  }

  async read(id: string): Promise<string | null> {
    validateDocumentId(id)
    await this.initialize()
    const inspected = await inspectRegularFile(this.pathFor(id), this.maxBytes)
    if (inspected.kind === 'missing') return null
    if (inspected.kind === 'invalid') throw new Error(inspected.error)
    return inspected.bytes.toString('utf8')
  }

  async delete(id: string): Promise<void> {
    validateDocumentId(id)
    await unlink(this.pathFor(id)).catch((error) => {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error
    })
  }

  private pathFor(id: string): string {
    return join(this.directory, `${id}.txt`)
  }
}

type InspectedFile =
  | { kind: 'missing' }
  | { kind: 'file'; mtimeMs: number; bytes: Buffer }
  | { kind: 'invalid'; error: string }

async function inspectRegularFile(path: string, maxBytes: number): Promise<InspectedFile> {
  try {
    const file = await readBoundedRegularFile(path, maxBytes)
    return { kind: 'file', mtimeMs: file.mtimeMs, bytes: file.bytes }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { kind: 'missing' }
    return {
      kind: 'invalid',
      error: error instanceof Error ? error.message : 'unable to inspect file',
    }
  }
}

async function readCurrentText(
  path: string,
  maxBytes: number,
): Promise<{ text: string; mtimeMs: number } | null> {
  const inspected = await inspectRegularFile(path, maxBytes)
  if (inspected.kind === 'missing') return null
  if (inspected.kind === 'invalid') throw new Error(inspected.error)
  return { text: inspected.bytes.toString('utf8'), mtimeMs: inspected.mtimeMs }
}

function validateDocumentId(id: string): void {
  if (!DOCUMENT_ID_PATTERN.test(id)) throw new Error('invalid document id')
}

function resultMessage(result: { reason: string; error?: string }): string {
  return result.error ?? result.reason
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
