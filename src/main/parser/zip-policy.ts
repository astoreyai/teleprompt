const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const MAX_END_RECORD_SEARCH = 65_557

export type ZipArchiveSummary = {
  entries: number
  compressedBytes: number
  expandedBytes: number
  ratio: number
}

export function inspectZipArchive(
  bytes: Uint8Array,
  limits: { maxEntries: number; maxExpandedBytes: number; maxRatio: number },
): ZipArchiveSummary {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const endOffset = findEndRecord(buffer)
  if (endOffset < 0 || endOffset + 22 > buffer.length) throw new Error('invalid ZIP archive')
  const entries = buffer.readUInt16LE(endOffset + 10)
  const centralSize = buffer.readUInt32LE(endOffset + 12)
  const centralOffset = buffer.readUInt32LE(endOffset + 16)
  if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported')
  }
  if (entries > limits.maxEntries) throw new Error('ZIP archive has too many entries')
  if (centralOffset + centralSize > buffer.length) throw new Error('invalid ZIP central directory')

  let offset = centralOffset
  let expandedBytes = 0
  let compressedBytes = 0
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('invalid ZIP central directory entry')
    }
    const flags = buffer.readUInt16LE(offset + 8)
    if ((flags & 0x1) !== 0) throw new Error('encrypted ZIP entries are not supported')
    const compressed = buffer.readUInt32LE(offset + 20)
    const expanded = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    if (compressed === 0xffffffff || expanded === 0xffffffff) {
      throw new Error('ZIP64 entries are not supported')
    }
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength
    if (nextOffset > buffer.length) throw new Error('invalid ZIP entry length')
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    if (name.startsWith('/') || name.startsWith('\\') || name.split(/[\\/]/).includes('..')) {
      throw new Error('unsafe ZIP entry path')
    }
    expandedBytes += expanded
    compressedBytes += compressed
    if (expandedBytes > limits.maxExpandedBytes) throw new Error('ZIP expanded content too large')
    offset = nextOffset
  }
  const ratio = expandedBytes / Math.max(1, compressedBytes)
  if (ratio > limits.maxRatio) throw new Error('ZIP compression ratio too high')
  return { entries, compressedBytes, expandedBytes, ratio }
}

function findEndRecord(buffer: Buffer): number {
  const first = Math.max(0, buffer.length - MAX_END_RECORD_SEARCH)
  for (let offset = buffer.length - 22; offset >= first; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) return offset
  }
  return -1
}
