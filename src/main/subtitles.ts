const TIMESTAMP_RE = /\d{1,2}:\d{2}:\d{2}[,.]\d+\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d+/

export function srtToText(s: string): string {
  return processCueBlocks(s)
}

export function vttToText(s: string): string {
  let body = s.replace(/\r\n/g, '\n')
  body = body.replace(/^WEBVTT[^\n]*\n+/i, '')
  body = body.replace(/^NOTE\b[^\n]*(\n[^\n]*)*?\n\n/gm, '')
  return processCueBlocks(body)
}

function processCueBlocks(s: string): string {
  const blocks = s.replace(/\r\n/g, '\n').split(/\n{2,}/)
  const out: string[] = []
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) continue
    let i = 0
    if (/^\d+$/.test(lines[i])) i++
    if (lines[i] && TIMESTAMP_RE.test(lines[i])) i++
    const text = lines.slice(i).join(' ').trim()
    if (text) out.push(text)
  }
  return out.join('\n').trim()
}
