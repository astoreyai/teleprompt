import type { DocumentFormat } from '../../../shared/contracts'
import { MAX_VOICE_PACING_CHARS } from '../../../shared/text'

export const MAX_MARKDOWN_RENDER_CHARS = MAX_VOICE_PACING_CHARS

export function shouldRenderMarkdown(
  contentLength: number,
  markdownEnabled: boolean,
  format: DocumentFormat | undefined,
): boolean {
  return (
    contentLength <= MAX_MARKDOWN_RENDER_CHARS &&
    (markdownEnabled || format === 'markdown')
  )
}
