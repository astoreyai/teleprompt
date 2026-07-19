import { randomUUID } from 'node:crypto'
import type {
  AppSnapshot,
  DocumentFormat,
  DocumentId,
  DocumentMeta,
  DocumentRecord,
  DocumentUpdateResult,
} from '../../shared/contracts.js'
import { createDefaultSnapshot } from '../../shared/defaults.js'
import { getSaveMode } from '../files/file-policy.js'

const DEFAULT_MAX_DOCUMENTS = 100
const DEFAULT_MAX_DOCUMENT_CHARS = 10 * 1024 * 1024
const DEFAULT_MAX_TOTAL_CHARS = 50 * 1024 * 1024
type DocumentUpdateValidation =
  | { ok: true; revision: number; previousLength: number }
  | Exclude<DocumentUpdateResult, { ok: true }>

export class WorkspaceLimitError extends Error {}

export class DocumentWorkspace {
  private snapshot: AppSnapshot
  private readonly records = new Map<DocumentId, DocumentRecord>()
  private totalChars = 0

  constructor(
    private readonly options: {
      idFactory?: () => string
      maxDocuments?: number
      maxDocumentChars?: number
      maxTotalChars?: number
    } = {},
  ) {
    this.snapshot = createDefaultSnapshot()
  }

  addDocument(input: {
    id?: DocumentId
    name: string
    sourcePath: string | null
    format: DocumentFormat
    content: string
    sourceMtimeMs: number | null
    sourceHash?: string | null
    revision?: number
    dirty?: boolean
  }): DocumentMeta {
    const maxDocuments = this.options.maxDocuments ?? DEFAULT_MAX_DOCUMENTS
    const maxDocumentChars = this.options.maxDocumentChars ?? DEFAULT_MAX_DOCUMENT_CHARS
    const maxTotalChars = this.options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS
    if (this.records.size >= maxDocuments) throw new WorkspaceLimitError('document limit reached')
    if (input.content.length > maxDocumentChars) throw new WorkspaceLimitError('document too large')
    if (this.totalChars + input.content.length > maxTotalChars)
      throw new WorkspaceLimitError('workspace content limit reached')

    const id = input.id ?? (this.options.idFactory ?? randomUUID)()
    if (this.records.has(id)) throw new Error(`duplicate document id: ${id}`)
    const record: DocumentRecord = {
      id,
      name: input.name.slice(0, 200),
      sourcePath: input.sourcePath,
      format: input.format,
      saveMode: getSaveMode(input),
      revision: Math.max(0, Math.floor(input.revision ?? 0)),
      dirty: input.dirty ?? input.sourcePath === null,
      sourceMtimeMs: input.sourceMtimeMs,
      sourceHash: input.sourceHash ?? null,
      content: input.content,
    }
    this.records.set(id, record)
    this.totalChars += record.content.length
    this.snapshot = {
      ...this.snapshot,
      documents: [...this.snapshot.documents, metaFrom(record)],
      activeDocumentId: this.snapshot.activeDocumentId ?? id,
    }
    return metaFrom(record)
  }

  removeDocument(id: DocumentId): boolean {
    const record = this.records.get(id)
    if (!record) return false
    const oldIndex = this.snapshot.documents.findIndex((document) => document.id === id)
    this.records.delete(id)
    this.totalChars -= record.content.length
    const documents = this.snapshot.documents.filter((document) => document.id !== id)
    let activeDocumentId = this.snapshot.activeDocumentId
    let playing = this.snapshot.playing
    let playbackSessionId = this.snapshot.playbackSessionId
    let scrollPosition = this.snapshot.scrollPosition
    if (activeDocumentId === id) {
      activeDocumentId = documents[Math.min(oldIndex, Math.max(0, documents.length - 1))]?.id ?? null
      playing = false
      playbackSessionId = null
      scrollPosition = 0
    }
    this.snapshot = {
      ...this.snapshot,
      documents,
      activeDocumentId,
      playing,
      playbackSessionId,
      scrollPosition,
    }
    return true
  }

  selectDocument(id: DocumentId): boolean {
    if (!this.records.has(id)) return false
    if (this.snapshot.activeDocumentId === id) return true
    this.snapshot = {
      ...this.snapshot,
      activeDocumentId: id,
      playing: false,
      playbackSessionId: null,
      scrollPosition: 0,
    }
    return true
  }

  restoreActiveDocument(id: DocumentId, scrollPosition: number): boolean {
    if (!this.records.has(id)) return false
    this.snapshot = {
      ...this.snapshot,
      activeDocumentId: id,
      scrollPosition: Math.max(0, Math.min(1, scrollPosition)),
      playing: false,
      playbackSessionId: null,
    }
    return true
  }

  updateDocument(input: {
    id: DocumentId
    expectedRevision: number
    content: string
  }): DocumentUpdateResult {
    const validation = this.validateDocumentUpdate(input)
    if (!validation.ok) return validation
    const record = this.records.get(input.id)
    if (!record) throw new Error('document update validation invariant failed')
    record.content = input.content
    record.revision += 1
    record.dirty = true
    this.totalChars = this.totalChars - validation.previousLength + input.content.length
    this.refreshMeta(record)
    return { ok: true, revision: record.revision }
  }

  validateDocumentUpdate(input: {
    id: DocumentId
    expectedRevision: number
    content: string
  }): DocumentUpdateValidation {
    const record = this.records.get(input.id)
    if (!record) return { ok: false, reason: 'not-found' }
    if (record.revision !== input.expectedRevision) {
      return { ok: false, reason: 'conflict', currentRevision: record.revision }
    }
    const maxDocumentChars = this.options.maxDocumentChars ?? DEFAULT_MAX_DOCUMENT_CHARS
    const maxTotalChars = this.options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS
    const nextTotal = this.totalChars - record.content.length + input.content.length
    if (input.content.length > maxDocumentChars || nextTotal > maxTotalChars) {
      return { ok: false, reason: 'too-large' }
    }
    return { ok: true, revision: record.revision + 1, previousLength: record.content.length }
  }

  markSaved(input: {
    id: DocumentId
    sourcePath: string
    format: DocumentFormat
    sourceMtimeMs: number
    sourceHash: string
  }): boolean {
    const record = this.records.get(input.id)
    if (!record) return false
    record.sourcePath = input.sourcePath
    record.name = input.sourcePath.split(/[\\/]/).pop() || record.name
    record.format = input.format
    record.saveMode = getSaveMode(record)
    record.sourceMtimeMs = input.sourceMtimeMs
    record.sourceHash = input.sourceHash
    record.dirty = false
    this.refreshMeta(record)
    return true
  }

  replaceDocument(
    id: DocumentId,
    input: {
      name: string
      sourcePath: string
      format: DocumentFormat
      content: string
      sourceMtimeMs: number
      sourceHash: string
    },
  ): DocumentMeta | null {
    const record = this.records.get(id)
    if (!record) return null
    const nextTotal = this.totalChars - record.content.length + input.content.length
    const maxDocumentChars = this.options.maxDocumentChars ?? DEFAULT_MAX_DOCUMENT_CHARS
    const maxTotalChars = this.options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS
    if (input.content.length > maxDocumentChars || nextTotal > maxTotalChars) {
      throw new WorkspaceLimitError('reloaded document is too large')
    }
    this.totalChars = nextTotal
    Object.assign(record, {
      ...input,
      saveMode: getSaveMode(input),
      revision: record.revision + 1,
      dirty: false,
    })
    this.refreshMeta(record)
    return metaFrom(record)
  }

  patchState(patch: Partial<Omit<AppSnapshot, 'schemaVersion' | 'documents' | 'activeDocumentId'>>): AppSnapshot {
    const next = { ...this.snapshot, ...patch }
    if (!next.activeDocumentId) next.playing = false
    if (!next.playing) next.playbackSessionId = null
    this.snapshot = next
    return this.getSnapshot()
  }

  restoreSettings(
    settings: Partial<Omit<AppSnapshot, 'schemaVersion' | 'documents' | 'activeDocumentId'>>,
  ): AppSnapshot {
    this.snapshot = {
      ...createDefaultSnapshot(),
      ...settings,
      documents: this.snapshot.documents,
      activeDocumentId: this.snapshot.activeDocumentId,
      playing: false,
      editMode: false,
      voicePacing: false,
      clickerMode: false,
      drivePresentation: false,
      playbackSessionId: null,
      overlayVisible: true,
      voiceStatus: 'off',
      voiceError: null,
    }
    return this.getSnapshot()
  }

  getSnapshot(): AppSnapshot {
    return {
      ...this.snapshot,
      documents: this.snapshot.documents.map((document) => ({ ...document })),
      hotkeyBindings: { ...this.snapshot.hotkeyBindings },
      recentFiles: [...this.snapshot.recentFiles],
      overlayBounds: { ...this.snapshot.overlayBounds },
      controlsBounds: { ...this.snapshot.controlsBounds },
    }
  }

  getDocument(id: DocumentId): DocumentRecord | null {
    const record = this.records.get(id)
    return record ? { ...record } : null
  }

  getActiveDocument(): DocumentRecord | null {
    const id = this.snapshot.activeDocumentId
    return id ? this.getDocument(id) : null
  }

  private refreshMeta(record: DocumentRecord): void {
    this.snapshot = {
      ...this.snapshot,
      documents: this.snapshot.documents.map((document) =>
        document.id === record.id ? metaFrom(record) : document,
      ),
    }
  }
}

export function createWorkspace(options?: ConstructorParameters<typeof DocumentWorkspace>[0]): DocumentWorkspace {
  return new DocumentWorkspace(options)
}

function metaFrom(record: DocumentRecord): DocumentMeta {
  const { content: _content, ...meta } = record
  return { ...meta }
}
