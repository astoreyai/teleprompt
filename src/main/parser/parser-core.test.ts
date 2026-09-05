import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDocumentBytes } from './parser-core.js'

// Repository documents and NASA's unmodified paired video captions. Caption
// source URL, acquisition time, and hashes are recorded beside the public files.
describe('document parser core with genuine source bytes', () => {
  it.each(['text', 'markdown', 'fountain'] as const)('preserves README text in %s mode', async format => {
    const bytes = await readFile(resolve('README.md'))
    expect(await parseDocumentBytes(format, bytes, { maxOutputChars: bytes.length }))
      .toBe(bytes.toString('utf8'))
  })

  it('removes the actual renderer HTML head and executable script', async () => {
    const bytes = await readFile(resolve('src/renderer/controls.html'))
    expect(bytes.toString('utf8')).toContain('<script')
    expect(bytes.toString('utf8')).toContain('<head>')
    expect(await parseDocumentBytes('html', bytes, { maxOutputChars: bytes.length })).toBe('')
  })

  it('extracts the same genuine NASA captions from SRT and VTT without timestamps', async () => {
    const srt = await readFile(resolve('test/fixtures/public/nasa-atom-alaska.srt'))
    const vtt = await readFile(resolve('test/fixtures/public/nasa-atom-alaska.vtt'))
    expect(vtt.toString('utf8')).toMatch(/^WEBVTT/)
    const text = await parseDocumentBytes('subtitle', srt, { maxOutputChars: srt.length })
    expect(text.length).toBeGreaterThan(0)
    expect(text).toContain('First stop: Alaska.')
    expect(text).not.toContain('-->')
    expect(text).not.toContain('WEBVTT')
    expect(await parseDocumentBytes('subtitle', vtt, { maxOutputChars: vtt.length })).toBe(text)
    await expect(parseDocumentBytes('subtitle', srt, { maxOutputChars: text.length - 1 }))
      .rejects.toThrow('extracted text too large')
  })

  it('rejects real binary input and actual text beyond the output boundary', async () => {
    const icon = await readFile(resolve('build/icon.png'))
    await expect(parseDocumentBytes('text', icon, { maxOutputChars: icon.length })).rejects.toThrow('binary')
    const bytes = await readFile(resolve('README.md'))
    await expect(parseDocumentBytes('text', bytes, { maxOutputChars: bytes.toString('utf8').length - 1 }))
      .rejects.toThrow('extracted text too large')
  })
})
