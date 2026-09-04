import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDocumentBytes } from './parser-core.js'

// Source bytes are actual repository files; no generated or edited text fixtures.
describe('parser core with real repository input', () => {
  it.each(['text', 'markdown', 'fountain'] as const)('decodes real README bytes as %s', async (format) => {
    const bytes = await readFile(resolve('README.md'))
    expect(await parseDocumentBytes(format, bytes, { maxOutputChars: bytes.length })).toBe(bytes.toString('utf8'))
  })

  it('strips the actual renderer HTML head and script', async () => {
    const bytes = await readFile(resolve('src/renderer/controls.html'))
    expect(bytes.toString('utf8')).toContain('<script')
    expect(bytes.toString('utf8')).toContain('<head>')
    expect(await parseDocumentBytes('html', bytes, { maxOutputChars: bytes.length })).toBe('')
  })

  it('rejects the real binary icon and real text beyond the output ceiling', async () => {
    const icon = await readFile(resolve('build/icon.png'))
    await expect(parseDocumentBytes('text', icon, { maxOutputChars: icon.length })).rejects.toThrow('binary')
    const bytes = await readFile(resolve('README.md'))
    await expect(parseDocumentBytes('text', bytes, { maxOutputChars: bytes.toString('utf8').length - 1 })).rejects.toThrow('extracted text too large')
  })
})
