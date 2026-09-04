import { createInflateRaw } from 'node:zlib'

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const LOCAL_FILE_SIGNATURE = 0x04034b50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const MAX_END_RECORD_SEARCH = 65_557

type ZipLimits = { maxEntries: number; maxExpandedBytes: number; maxRatio: number }
type ZipEntry = { start: number; end: number; expanded: number; method: number }
export type ZipArchiveSummary = {
  entries: number
  compressedBytes: number
  expandedBytes: number
  ratio: number
}

export function inspectZipArchive(bytes: Uint8Array, limits: ZipLimits): ZipArchiveSummary {
  return inspect(bytes, limits).summary
}

// Validate the same immutable compressed bytes before either office extractor accumulates output.
// Deflate output is counted and discarded in bounded chunks; declared sizes alone are not trusted.
export async function validateZipExpansion(bytes: Uint8Array, limits: ZipLimits): Promise<void> {
  const { buffer, entries } = inspect(bytes, limits)
  let total = 0
  for (const entry of entries) {
    if (entry.method === 0) {
      total += entry.end - entry.start
      if (entry.end - entry.start !== entry.expanded) throw new Error('ZIP expanded size mismatch')
    } else {
      const inflater = createInflateRaw({ chunkSize: 16 * 1024 })
      let expanded = 0
      inflater.end(buffer.subarray(entry.start, entry.end))
      try {
        for await (const chunk of inflater) {
          expanded += chunk.length
          total += chunk.length
          if (expanded > entry.expanded || total > limits.maxExpandedBytes) {
            throw new Error('ZIP expanded content too large')
          }
        }
        if (expanded !== entry.expanded || inflater.bytesWritten !== entry.end - entry.start) {
          throw new Error('ZIP expanded size or compressed extent mismatch')
        }
      } finally {
        inflater.destroy()
      }
    }
    if (total > limits.maxExpandedBytes) throw new Error('ZIP expanded content too large')
  }
}

function inspect(bytes: Uint8Array, limits: ZipLimits): {
  buffer: Buffer; entries: ZipEntry[]; summary: ZipArchiveSummary
} {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const endOffset = findEndRecord(buffer)
  if (endOffset < 0) throw new Error('invalid ZIP archive')
  const disk = buffer.readUInt16LE(endOffset + 4)
  const centralDisk = buffer.readUInt16LE(endOffset + 6)
  const diskEntries = buffer.readUInt16LE(endOffset + 8)
  const count = buffer.readUInt16LE(endOffset + 10)
  const centralSize = buffer.readUInt32LE(endOffset + 12)
  const centralOffset = buffer.readUInt32LE(endOffset + 16)
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== count) throw new Error('multidisk ZIP archives are not supported')
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported')
  if (count > limits.maxEntries) throw new Error('ZIP archive has too many entries')
  // No prefix adjustment, undeclared central entries, ZIP64 records, or intervening data.
  if (centralOffset + centralSize !== endOffset) throw new Error('invalid ZIP central directory extent')

  const entries: ZipEntry[] = []
  const localRanges: Array<{ start: number; end: number }> = []
  const names = new Set<string>()
  let offset = centralOffset
  let expandedBytes = 0
  let compressedBytes = 0
  while (offset < endOffset) {
    if (entries.length >= count) throw new Error('ZIP central directory entry count mismatch')
    if (offset + 46 > endOffset || buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) throw new Error('invalid ZIP central directory entry')
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const crc = buffer.readUInt32LE(offset + 16)
    const compressed = buffer.readUInt32LE(offset + 20)
    const expanded = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const entryDisk = buffer.readUInt16LE(offset + 34)
    const localOffset = buffer.readUInt32LE(offset + 42)
    if ((flags & 0x2041) !== 0) throw new Error('encrypted ZIP entries are not supported')
    if (method !== 0 && method !== 8) throw new Error('unsupported ZIP compression method')
    if (entryDisk !== 0) throw new Error('multidisk ZIP entries are not supported')
    if (compressed === 0xffffffff || expanded === 0xffffffff || localOffset === 0xffffffff) throw new Error('ZIP64 entries are not supported')
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength
    if (nextOffset > endOffset) throw new Error('invalid ZIP entry length')
    const nameBytes = buffer.subarray(offset + 46, offset + 46 + nameLength)
    const name = nameBytes.toString('utf8')
    if (!name || name.includes('\0') || name.startsWith('/') || name.startsWith('\\') || /^[a-z]:/i.test(name) || name.split(/[\\/]/).includes('..')) throw new Error('unsafe ZIP entry path')
    if (names.has(name)) throw new Error('duplicate ZIP entry path')
    names.add(name)
    validateExtra(buffer, offset + 46 + nameLength, extraLength)
    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== LOCAL_FILE_SIGNATURE) throw new Error('invalid ZIP local entry')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const end = start + compressed
    if (end > centralOffset || start > centralOffset || buffer.readUInt16LE(localOffset + 6) !== flags || buffer.readUInt16LE(localOffset + 8) !== method || !buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes)) throw new Error('ZIP local and central metadata mismatch')
    validateExtra(buffer, localOffset + 30 + localNameLength, localExtraLength)
    let localEnd = end
    if ((flags & 8) === 0) {
      if (buffer.readUInt32LE(localOffset + 14) !== crc || buffer.readUInt32LE(localOffset + 18) !== compressed || buffer.readUInt32LE(localOffset + 22) !== expanded) throw new Error('ZIP local and central sizes mismatch')
    } else {
      const descriptor = end + (end + 4 <= centralOffset && buffer.readUInt32LE(end) === 0x08074b50 ? 4 : 0)
      localEnd = descriptor + 12
      if (localEnd > centralOffset || buffer.readUInt32LE(descriptor) !== crc || buffer.readUInt32LE(descriptor + 4) !== compressed || buffer.readUInt32LE(descriptor + 8) !== expanded) throw new Error('invalid ZIP data descriptor')
    }
    localRanges.push({ start: localOffset, end: localEnd })
    entries.push({ start, end, expanded, method })
    expandedBytes += expanded
    compressedBytes += compressed
    if (expandedBytes > limits.maxExpandedBytes) throw new Error('ZIP expanded content too large')
    offset = nextOffset
  }
  if (entries.length !== count || offset !== endOffset) throw new Error('ZIP central directory entry count mismatch')
  localRanges.sort((left, right) => left.start - right.start)
  let consumed = 0
  for (const range of localRanges) {
    if (range.start !== consumed) throw new Error('ZIP local entries overlap or contain undeclared data')
    consumed = range.end
  }
  if (consumed !== centralOffset) throw new Error('ZIP local directory extent mismatch')
  const ratio = expandedBytes / Math.max(1, compressedBytes)
  if (ratio > limits.maxRatio) throw new Error('ZIP compression ratio too high')
  return { buffer, entries, summary: { entries: count, compressedBytes, expandedBytes, ratio } }
}

function validateExtra(buffer: Buffer, start: number, length: number): void {
  const end = start + length
  for (let offset = start; offset < end;) {
    if (offset + 4 > end) throw new Error('invalid ZIP extra field')
    const id = buffer.readUInt16LE(offset)
    const size = buffer.readUInt16LE(offset + 2)
    if (id === 1) throw new Error('ZIP64 entries are not supported')
    // Alternate Unicode names can cause JSZip to consume a different path than validated.
    if (id === 0x7075) throw new Error('alternate ZIP entry names are not supported')
    offset += 4 + size
    if (offset > end) throw new Error('invalid ZIP extra field')
  }
}

function findEndRecord(buffer: Buffer): number {
  const first = Math.max(0, buffer.length - MAX_END_RECORD_SEARCH)
  // JSZip searches backwards for the last signature. Reject a false signature in a comment
  // rather than validating an earlier EOCD that the extractor would not consume.
  for (let offset = buffer.length - 4; offset >= first; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue
    if (offset + 22 > buffer.length || offset + 22 + buffer.readUInt16LE(offset + 20) !== buffer.length) return -1
    return offset
  }
  return -1
}
