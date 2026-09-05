import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { countWords } from './text.js'

// Genuine production translations; see test/fixtures/public/localization/provenance.json.
// TypeScript translations are shipped by the actual locked compiler dependency.
describe('text statistics with real published application text', () => {
  it.each([
    ['fr', 'Name_is_not_valid_95136', 5],
    ['ru', 'Unterminated_string_literal_1002', 5],
  ] as const)('counts actual %s diagnostic text including punctuation', async (locale, key, words) => {
    const messages = JSON.parse(await readFile(resolve(`node_modules/typescript/lib/${locale}/diagnosticMessages.generated.json`), 'utf8'))
    const content = messages[key]
    expect(typeof content).toBe('string')
    // French: Le / nom / n'est / pas / valide. Russian: five Cyrillic words.
    expect(countWords(content)).toBe(words)
    expect(countWords(content)).toBe(words)
  })

  it.each(['ar', 'he'])('counts the actual newt %s Cancel translation', async (locale) => {
    const content = await readFile(resolve(`test/fixtures/public/localization/${locale}-cancel.txt`), 'utf8')
    expect(content.length).toBeGreaterThan(0)
    expect(countWords(content)).toBe(1)
  })

  it('counts the actual security-policy title and an empty native device read', async () => {
    const title = (await readFile(resolve('SECURITY.md'), 'utf8')).split('\n')[0]
    expect(title).toBe('# Security policy')
    expect(countWords(title)).toBe(2)
    expect(countWords(await readFile('/dev/null', 'utf8'))).toBe(0)
  })
})
