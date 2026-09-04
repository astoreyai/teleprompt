const WORD_RE = /[A-Za-z0-9À-ɏЀ-ӿ֐-׿؀-ۿ']+/g

export const MAX_VOICE_PACING_CHARS = 500_000
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024

export function countWords(content: string): number {
  WORD_RE.lastIndex = 0
  let count = 0
  while (WORD_RE.exec(content) !== null) count += 1
  return count
}
