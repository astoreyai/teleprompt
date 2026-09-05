import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { PDFParse } from 'pdf-parse'
import { parseDocumentBytes } from './parser-core.js'

describe('PDF extraction against an unmodified real document', () => {
  it('preserves the installed extractor output and enforces its exact character boundary', async () => {
    const path = process.env.TELEPROMPT_REAL_PDF
    if (!path) throw new Error('TELEPROMPT_REAL_PDF must name a genuine PDF')
    const bytes = await readFile(path)
    const reference = new PDFParse({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false })
    try {
      const original = await reference.getText()
      const text = original.text.trim()
      expect(original.total).toBeGreaterThan(1)
      expect(text.length).toBeGreaterThan(0)
      expect(await parseDocumentBytes('pdf', bytes, { maxOutputChars: text.length })).toBe(text)
      await expect(parseDocumentBytes('pdf', bytes, { maxOutputChars: text.length - 1 }))
        .rejects.toThrow('extracted text too large')
      const firstPage = await reference.getText({ partial: [1] })
      await expect(parseDocumentBytes('pdf', bytes, { maxOutputChars: firstPage.text.trim().length - 1 }))
        .rejects.toThrow('extracted text too large')
    } finally {
      await reference.destroy()
    }
  })
})
