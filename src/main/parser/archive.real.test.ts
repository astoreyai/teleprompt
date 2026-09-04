import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parseDocumentBytes } from './parser-core.js'
import { inspectZipArchive, validateZipExpansion } from './zip-policy.js'

// Optional operator-owned corpus stays outside the repository and is read without modification.
// These paths must point to actual documents, never generated test archives.
const officePath = process.env.TELEPROMPT_REAL_DOCX
const pdfPath = process.env.TELEPROMPT_REAL_PDF
const limits = { maxEntries: 2_000, maxExpandedBytes: 25 * 1024 * 1024, maxRatio: 100 }

describe.skipIf(!officePath)('operator-supplied real DOCX', () => {
  it('validates directory, streams expansion, and extracts genuine office text', async () => {
    const bytes = await readFile(officePath!)
    const summary = inspectZipArchive(bytes, limits)
    expect(summary.entries).toBeGreaterThan(0)
    await validateZipExpansion(bytes, limits)
    const text = await parseDocumentBytes('docx', bytes, { maxOutputChars: 10 * 1024 * 1024 })
    expect(text.trim().length).toBeGreaterThan(0)
    expect((await stat(officePath!)).size).toBe(bytes.length)
    expect(createHash('sha256').update(await readFile(officePath!)).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'))
  })

  it('rejects actual archive at entry, expanded-byte, and ratio ceilings', async () => {
    const bytes = await readFile(officePath!)
    const summary = inspectZipArchive(bytes, limits)
    expect(() => inspectZipArchive(bytes, { ...limits, maxEntries: summary.entries - 1 })).toThrow('too many entries')
    expect(() => inspectZipArchive(bytes, { ...limits, maxExpandedBytes: summary.expandedBytes - 1 })).toThrow('expanded content too large')
    expect(() => inspectZipArchive(bytes, { ...limits, maxRatio: summary.ratio / 2 })).toThrow('compression ratio')
  })
})

describe.skipIf(!pdfPath)('operator-supplied real PDF', () => {
  it('extracts real text and releases the parser', async () => {
    const bytes = await readFile(pdfPath!)
    expect((await parseDocumentBytes('pdf', bytes, { maxOutputChars: 10 * 1024 * 1024 })).trim().length).toBeGreaterThan(0)
  })
})
