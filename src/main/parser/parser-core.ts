import { pathToFileURL } from 'node:url'
import type { DocumentFormat } from '../../shared/contracts.js'
import { stripHtmlTags } from '../html.js'
import { odtToText } from '../odt.js'
import { rtfToText } from '../rtf.js'
import { srtToText, vttToText } from '../subtitles.js'
import { validateZipExpansion } from './zip-policy.js'

const DEFAULT_ZIP_LIMITS = {
  maxEntries: 2_000,
  maxExpandedBytes: 25 * 1024 * 1024,
  maxRatio: 100,
}

export async function parseDocumentBytes(
  format: DocumentFormat,
  bytes: Uint8Array,
  options: { maxOutputChars: number },
): Promise<string> {
  if (format === 'docx' || format === 'odt') await validateZipExpansion(bytes, DEFAULT_ZIP_LIMITS)
  let content: string
  switch (format) {
    case 'docx': {
      const mammoth = await import('mammoth')
      const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
      content = result.value
      break
    }
    case 'rtf':
      content = rtfToText(decodeText(bytes))
      break
    case 'pdf': {
      // PDF.js excludes Electron utility processes from its Node setup. Install
      // the same real graphics classes and load its actual worker in this
      // already killable process before importing the PDF facade.
      if (process.versions.electron && process.type === 'utility') {
        const { DOMMatrix, ImageData, Path2D } = await import('@napi-rs/canvas')
        Object.assign(globalThis, { DOMMatrix, ImageData, Path2D })
        const { getPath } = await import('pdf-parse/worker')
        await import(/* @vite-ignore */ pathToFileURL(getPath()).href)
      }
      const { PDFParse } = await import('pdf-parse')
      const parser = new PDFParse({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false })
      try {
        const pages: string[] = []
        let totalPages = 1
        let length = 0
        for (let page = 1; page <= totalPages; page += 1) {
          // getText() otherwise retains every page before exposing its result.
          // Keep the supported extractor's formatting, checking each page before
          // retaining another. A single page still requires native containment.
          const result = await parser.getText({ partial: [page] })
          totalPages = result.total
          let text = result.text ?? ''
          if (page === 1) text = text.trimStart()
          if (page === totalPages) text = text.trimEnd()
          length += text.length
          if (length > options.maxOutputChars) throw new Error('extracted text too large')
          pages.push(text)
        }
        content = pages.join('')
      } finally {
        await parser.destroy()
      }
      if (!content) throw new Error('no extractable text; PDF may be image-only')
      break
    }
    case 'html':
      content = stripHtmlTags(decodeText(bytes))
      break
    case 'odt':
      content = await odtToText(Buffer.from(bytes))
      break
    case 'subtitle': {
      const source = decodeText(bytes)
      content = /^\s*WEBVTT\b/i.test(source) ? vttToText(source) : srtToText(source)
      break
    }
    case 'text':
    case 'markdown':
    case 'fountain':
      content = decodeText(bytes)
      break
  }
  if (content.length > options.maxOutputChars) throw new Error('extracted text too large')
  return content
}

function decodeText(bytes: Uint8Array): string {
  const cap = Math.min(bytes.length, 64 * 1024)
  for (let index = 0; index < cap; index += 1) {
    if (bytes[index] === 0) throw new Error('binary text input')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('file is not valid UTF-8 text')
  }
}
