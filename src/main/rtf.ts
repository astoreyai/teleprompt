const SKIP_GROUPS = ['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'object', 'themedata', 'datastore', 'latentstyles']

export function rtfToText(rtf: string): string {
  let out = rtf
  for (const kw of SKIP_GROUPS) out = stripGroup(out, '\\' + kw)
  out = out.replace(/\\u(-?\d+)\??/g, (_, code) => {
    const n = parseInt(code, 10)
    return String.fromCharCode(n < 0 ? n + 65536 : n)
  })
  out = out.replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  out = out.replace(/\\par[d]?\b ?/g, '\n')
  out = out.replace(/\\line\b ?/g, '\n')
  out = out.replace(/\\tab\b ?/g, '\t')
  out = out.replace(/\\[a-zA-Z]+-?\d* ?/g, '')
  out = out.replace(/[{}]/g, '')
  out = out.replace(/\\([\\{}])/g, '$1')
  out = out.replace(/\r\n/g, '\n').replace(/\n[ \t]*\n+/g, '\n\n').trim()
  return out
}

function stripGroup(rtf: string, keyword: string): string {
  let result = ''
  let i = 0
  while (i < rtf.length) {
    const idx = rtf.indexOf('{' + keyword, i)
    if (idx === -1) {
      result += rtf.slice(i)
      break
    }
    result += rtf.slice(i, idx)
    let depth = 1
    let j = idx + 1
    while (j < rtf.length && depth > 0) {
      const c = rtf[j]
      if (c === '\\' && j + 1 < rtf.length) {
        j += 2
        continue
      }
      if (c === '{') depth++
      else if (c === '}') depth--
      j++
    }
    i = j
  }
  return result
}
