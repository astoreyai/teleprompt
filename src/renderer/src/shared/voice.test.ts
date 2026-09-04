import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stripCues } from '../../../shared/cues'
import { progressForToken, tokenize } from './voice'

describe('voice pacing progress', () => {
  it('uses actual repository text and clamps the result', () => {
    const visibleText = stripCues(readFileSync(resolve('README.md'), 'utf8'))
    const tokens = tokenize(visibleText)
    expect(tokens.length).toBeGreaterThan(2)
    expect(progressForToken(tokens, 2, visibleText.length)).toBeCloseTo(tokens[2].start / visibleText.length)
    expect(progressForToken(tokens, tokens.length, visibleText.length)).toBeLessThanOrEqual(1)
    expect(progressForToken([], 0, 0)).toBe(0)
  })
})
