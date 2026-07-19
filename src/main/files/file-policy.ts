import { extname } from 'node:path'
import type { DocumentFormat, SaveMode } from '../../shared/contracts.js'

export type { DocumentFormat, SaveMode } from '../../shared/contracts.js'

const FORMAT_BY_EXTENSION: Readonly<Record<string, DocumentFormat>> = {
  '.txt': 'text',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.fountain': 'fountain',
  '.rtf': 'rtf',
  '.docx': 'docx',
  '.odt': 'odt',
  '.pdf': 'pdf',
  '.html': 'html',
  '.htm': 'html',
  '.srt': 'subtitle',
  '.vtt': 'subtitle',
}

const LOSSLESS_TEXT_FORMATS: ReadonlySet<DocumentFormat> = new Set([
  'text',
  'markdown',
  'fountain',
])

export function classifyDocumentPath(path: string): DocumentFormat | null {
  if (typeof path !== 'string' || path.length === 0) return null
  return FORMAT_BY_EXTENSION[extname(path).toLowerCase()] ?? null
}

export function isLosslessTextFormat(format: DocumentFormat): boolean {
  return LOSSLESS_TEXT_FORMATS.has(format)
}

export function getSaveMode(document: {
  sourcePath: string | null
  format: DocumentFormat
}): SaveMode {
  if (!document.sourcePath) return 'save-as'
  return isLosslessTextFormat(document.format) ? 'overwrite' : 'save-as'
}

export function supportedExtensions(): string[] {
  return Object.keys(FORMAT_BY_EXTENSION).map((extension) => extension.slice(1))
}
