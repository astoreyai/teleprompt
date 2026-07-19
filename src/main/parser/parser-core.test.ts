import { describe, expect, it } from 'vitest'
import { parseDocumentBytes } from './parser-core.js'

describe('document parser core', () => {
  it.each([
    ['text', Buffer.from('Plain text'), 'Plain text'],
    ['markdown', Buffer.from('# Heading'), '# Heading'],
    ['fountain', Buffer.from('INT. STAGE - DAY'), 'INT. STAGE - DAY'],
    ['html', Buffer.from('<h1>Hello</h1><script>bad()</script>'), 'Hello'],
    ['subtitle', Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello\n'), 'Hello'],
  ] as const)('parses bounded %s content', async (format, bytes, expected) => {
    expect(await parseDocumentBytes(format, bytes, { maxOutputChars: 1000 })).toContain(expected)
  })

  it('rejects binary text and extracted output over the configured cap', async () => {
    await expect(
      parseDocumentBytes('text', Buffer.from([65, 0, 66]), { maxOutputChars: 100 }),
    ).rejects.toThrow('binary')
    await expect(
      parseDocumentBytes('html', Buffer.from(`<p>${'x'.repeat(20)}</p>`), { maxOutputChars: 10 }),
    ).rejects.toThrow('extracted text too large')
  })
})
