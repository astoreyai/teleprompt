import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { inspectZipArchive } from './zip-policy.js'

describe('zip archive policy', () => {
  it('accepts a small bounded archive', async () => {
    const zip = new JSZip()
    zip.file('content.xml', '<p>Hello</p>')
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    expect(inspectZipArchive(bytes, { maxEntries: 4, maxExpandedBytes: 1024, maxRatio: 20 })).toMatchObject({
      entries: 1,
    })
  })

  it('rejects excessive expansion and entry counts before extraction', async () => {
    const expanding = new JSZip()
    expanding.file('content.xml', 'A'.repeat(100_000))
    const expandingBytes = await expanding.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    expect(() =>
      inspectZipArchive(expandingBytes, {
        maxEntries: 4,
        maxExpandedBytes: 200_000,
        maxRatio: 10,
      }),
    ).toThrow('compression ratio')

    const crowded = new JSZip()
    for (let index = 0; index < 5; index += 1) crowded.file(`${index}.txt`, 'x')
    const crowdedBytes = await crowded.generateAsync({ type: 'nodebuffer' })
    expect(() =>
      inspectZipArchive(crowdedBytes, {
        maxEntries: 4,
        maxExpandedBytes: 1024,
        maxRatio: 20,
      }),
    ).toThrow('too many entries')
  })
})
