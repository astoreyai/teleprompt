import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

const READ_CHUNK_BYTES = 64 * 1024

export type BoundedFile = {
  bytes: Buffer
  size: number
  mtimeMs: number
}

export async function readBoundedRegularFile(path: string, maxBytes: number): Promise<BoundedFile> {
  if (typeof path !== 'string' || path.length === 0) throw new Error('invalid path')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('invalid byte limit')
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0
  const nonBlocking = 'O_NONBLOCK' in constants ? constants.O_NONBLOCK : 0
  let file
  try {
    file = await open(path, constants.O_RDONLY | noFollow | nonBlocking)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ELOOP') {
      throw new Error('refusing to read a symbolic link')
    }
    throw error
  }

  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Error('path is not a regular file')
    if (info.size > maxBytes) throw new Error(`file too large (maximum ${maxBytes} bytes)`)

    const chunks: Buffer[] = []
    let total = 0
    while (true) {
      const remaining = maxBytes + 1 - total
      if (remaining <= 0) throw new Error(`file too large (maximum ${maxBytes} bytes)`)
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining))
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > maxBytes) throw new Error(`file too large (maximum ${maxBytes} bytes)`)
      chunks.push(chunk.subarray(0, bytesRead))
    }
    return { bytes: Buffer.concat(chunks, total), size: total, mtimeMs: info.mtimeMs }
  } finally {
    await file.close()
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
