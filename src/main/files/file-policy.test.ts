import { describe, expect, it } from 'vitest'
import { classifyDocumentPath, getSaveMode } from './file-policy.js'

describe('file policy', () => {
  it.each([
    ['notes.txt', 'text', 'overwrite'],
    ['talk.md', 'markdown', 'overwrite'],
    ['screenplay.fountain', 'fountain', 'overwrite'],
    ['brief.docx', 'docx', 'save-as'],
    ['slides.pdf', 'pdf', 'save-as'],
    ['source.odt', 'odt', 'save-as'],
    ['styled.rtf', 'rtf', 'save-as'],
    ['page.html', 'html', 'save-as'],
    ['captions.srt', 'subtitle', 'save-as'],
    ['captions.vtt', 'subtitle', 'save-as'],
  ] as const)('%s is classified as %s with %s saving', (path, format, saveMode) => {
    expect(classifyDocumentPath(path)).toBe(format)
    expect(getSaveMode({ sourcePath: `/tmp/${path}`, format })).toBe(saveMode)
  })

  it('forces memory documents through Save As', () => {
    expect(getSaveMode({ sourcePath: null, format: 'markdown' })).toBe('save-as')
  })

  it('rejects unsupported extensions instead of treating them as text', () => {
    expect(classifyDocumentPath('payload.bin')).toBeNull()
  })
})
