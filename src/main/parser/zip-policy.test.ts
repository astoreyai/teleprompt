import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { inspectZipArchive, validateZipExpansion } from './zip-policy.js'

// The optional corpus is an actual operator-owned document, read without transformation.
// Binary document bytes stay outside the repository; do not supply generated test archives.
const officePath = process.env.TELEPROMPT_REAL_DOCX
const limits = { maxEntries: 2_000, maxExpandedBytes: 25 * 1024 * 1024, maxRatio: 100 }

describe.skipIf(!officePath)('zip archive policy with real office input', () => {
  it('accepts a bounded archive and validates its actual streamed expansion', async () => {
    const bytes = await readFile(officePath!)
    expect(inspectZipArchive(bytes, limits).entries).toBeGreaterThan(0)
    await expect(validateZipExpansion(bytes, limits)).resolves.toBeUndefined()
  })

  it('rejects excessive expansion and entry counts before extraction', async () => {
    const bytes = await readFile(officePath!)
    const summary = inspectZipArchive(bytes, limits)
    expect(() => inspectZipArchive(bytes, { ...limits, maxRatio: summary.ratio / 2 })).toThrow('compression ratio')
    expect(() => inspectZipArchive(bytes, { ...limits, maxEntries: summary.entries - 1 })).toThrow('too many entries')
    expect(() => inspectZipArchive(bytes, { ...limits, maxExpandedBytes: summary.expandedBytes - 1 })).toThrow('expanded content too large')
  })
})
