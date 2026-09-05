import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCues, stripCues } from './cues.js'

// These are real repository documents without cue markers. Actual scripts carrying
// valid/malformed cues or the 1,000-cue boundary are still required for those paths;
// no authored marker sequences stand in for that missing corpus.
describe('cue parsing of genuine source documents', () => {
  it.each(['LICENSE', 'SECURITY.md'])('preserves actual non-cue source %s across repeated calls', async (path) => {
    const content = await readFile(resolve(path), 'utf8')
    expect(content).not.toMatch(/\[\[CUE:/i)
    expect(parseCues(content)).toEqual([])
    expect(stripCues(content)).toBe(content)
    expect(parseCues(content)).toEqual([])
  })
})
