import type { DocumentFormat } from '../../../shared/contracts'

export const MAX_MARKDOWN_RENDER_CHARS = 500_000

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
