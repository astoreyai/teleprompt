export type Cue = {
  index: number
  name: string
  charPos: number
  position: number
}

const CUE_RE = /\[\[CUE:\s*([^\]\r\n]+?)\s*\]\]/gi

export function stripCues(content: string): string {
  CUE_RE.lastIndex = 0
  return content.replace(CUE_RE, '')
}

export function parseCues(content: string): Cue[] {
  CUE_RE.lastIndex = 0
  const matches: { idx: number; len: number; name: string }[] = []
  let m: RegExpExecArray | null
  while ((m = CUE_RE.exec(content)) !== null) {
    matches.push({ idx: m.index, len: m[0].length, name: m[1] })
  }
  if (matches.length === 0) return []
  const total = Math.max(1, content.length - matches.reduce((s, mm) => s + mm.len, 0))
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
