import { describe, expect, it } from 'vitest'
import { parseCues, stripCues } from './cues.js'

describe('cue parsing', () => {
  it('returns no cues for ordinary text and remains stable across repeated calls', () => {
    expect(parseCues('ordinary script')).toEqual([])
    expect(stripCues('ordinary script')).toBe('ordinary script')
    expect(parseCues('ordinary script')).toEqual([])
  })

  it('strips case-insensitive markers and calculates positions in visible text', () => {
    const script = 'Start [[CUE: Intro]] middle [[cue:  Closing  ]] end'
    expect(stripCues(script)).toBe('Start  middle  end')
    expect(parseCues(script)).toEqual([
      { index: 0, name: 'Intro', charPos: 6, position: 6 / 18 },
      { index: 1, name: 'Closing', charPos: 14, position: 14 / 18 },
    ])
  })

  it('never emits an end cue at the terminal playback position', () => {
    const cue = parseCues(`text${'x'.repeat(1000)}[[CUE: end]]`)[0]
    expect(cue.position).toBe(0.999)
    expect(cue.name).toBe('end')
  })

  it('does not treat multiline or empty markers as cues', () => {
    expect(parseCues('[[CUE: ]] [[CUE: line\nbreak]]')).toEqual([])
  })

  it('bounds cue names and result count for renderer safety', () => {
    expect(parseCues(`[[CUE: ${'x'.repeat(201)}]]`)).toEqual([])
    const many = Array.from({ length: 1_001 }, (_, index) => `[[CUE: cue-${index}]] text`).join(' ')
    const cues = parseCues(many)
    expect(cues).toHaveLength(1_000)
    expect(cues.at(-1)?.name).toBe('cue-999')
  })
})
