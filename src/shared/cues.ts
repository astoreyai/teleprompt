export type Cue = {
  index: number
  name: string
  charPos: number
  position: number
}

const CUE_RE = /\[\[CUE:\s*([^\]\r\n]{0,199}?[^\s\]\r\n])\s*\]\]/gi
const MAX_CUES = 1_000

export function stripCues(content: string): string {
  CUE_RE.lastIndex = 0
  return content.replace(CUE_RE, '')
}

export function parseCues(content: string): Cue[] {
  CUE_RE.lastIndex = 0
  const matches: { idx: number; len: number; name: string }[] = []
  let removedTotal = 0
  let m: RegExpExecArray | null
  while ((m = CUE_RE.exec(content)) !== null) {
    removedTotal += m[0].length
    if (matches.length < MAX_CUES) {
      matches.push({ idx: m.index, len: m[0].length, name: m[1].trim() })
    }
  }
  if (matches.length === 0) return []
  const total = Math.max(1, content.length - removedTotal)
  const cues: Cue[] = []
  let removed = 0
  for (let i = 0; i < matches.length; i++) {
    const mm = matches[i]
    const strippedIdx = mm.idx - removed
    cues.push({
      index: i,
      name: mm.name,
      charPos: strippedIdx,
      position: Math.min(0.999, strippedIdx / total),
    })
    removed += mm.len
  }
  return cues
}
