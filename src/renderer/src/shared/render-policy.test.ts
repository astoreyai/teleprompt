import { describe, expect, it } from 'vitest'
import { shouldRenderMarkdown } from './render-policy'

describe('overlay rich-render policy', () => {
  it('renders normal Markdown but falls back to a plain text node for huge documents', () => {
    expect(shouldRenderMarkdown(10_000, false, 'markdown')).toBe(true)
    expect(shouldRenderMarkdown(10_000, true, 'text')).toBe(true)
    expect(shouldRenderMarkdown(500_001, true, 'markdown')).toBe(false)
    expect(shouldRenderMarkdown(10_000, false, 'text')).toBe(false)
  })
})
