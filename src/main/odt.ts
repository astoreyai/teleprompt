import JSZip from 'jszip'

export async function odtToText(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf)
  const xml = await zip.file('content.xml')?.async('string')
  if (!xml) throw new Error('invalid odt: missing content.xml')
  let s = xml
  s = s.replace(/<text:line-break\s*\/?>/g, '\n')
  s = s.replace(/<text:tab\s*\/?>/g, '\t')
  s = s.replace(/<text:s(\s+text:c="(\d+)")?\s*\/?>/g, (_, __, count) =>
    ' '.repeat(count ? Math.min(parseInt(count, 10), 80) : 1),
  )
  s = s.replace(/<text:h\b[^>]*>/g, '')
  s = s.replace(/<\/text:h>/g, '\n\n')
  s = s.replace(/<text:p\b[^>]*>/g, '')
  s = s.replace(/<\/text:p>/g, '\n')
  s = s.replace(/<[^>]+>/g, '')
  s = s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  return s.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
