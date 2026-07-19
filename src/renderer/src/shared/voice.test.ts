import { describe, expect, it } from 'vitest'
import { progressForToken, tokenize } from './voice'

describe('voice pacing progress', () => {
  it('uses the cue-stripped text length and clamps the result', () => {
    const visibleText = 'one two three'
    const tokens = tokenize(visibleText)

    expect(progressForToken(tokens, 2, visibleText.length)).toBeCloseTo(8 / 13)
    expect(progressForToken(tokens, 99, visibleText.length)).toBeLessThanOrEqual(1)
    expect(progressForToken([], 0, 0)).toBe(0)
  })
})
