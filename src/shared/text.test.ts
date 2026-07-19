import { describe, expect, it } from 'vitest'
import { countWords } from './text.js'

describe('bounded text statistics', () => {
  it('counts supported scripts without allocating a token array', () => {
    expect(countWords("One two, l'été — привет שלום مرحبا")).toBe(6)
    expect(countWords('')).toBe(0)
  })
})
