import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
} from 'node:fs'
import { dirname } from 'node:path'

export function appendDiagnosticLine(
  path: string,
  message: string,
  options: { maxBytes?: number } = {},
): void {
  try {
    const maxBytes = Math.max(1, options.maxBytes ?? 512 * 1024)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const line = `${new Date().toISOString()} ${redact(message).replace(/[\r\n\0]+/g, ' ').slice(0, 4096)}\n`
    const existing = inspect(path)
    if (existing === null) return
    if (existing + Buffer.byteLength(line) > maxBytes) rotate(path)
    const descriptor = openSync(
      path,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      chmodSync(path, 0o600)
      appendFileSync(descriptor, line, 'utf8')
    } finally {
      closeSync(descriptor)
    }
  } catch {
    // Diagnostics must never take down the application.
  }
}

function inspect(path: string): number | null {
  if (!existsSync(path)) return 0
  const info = lstatSync(path)
  return info.isFile() && !info.isSymbolicLink() ? info.size : null
}

function rotate(path: string): void {
  const backup = `${path}.1`
  if (existsSync(backup)) unlinkSync(backup)
  if (existsSync(path)) renameSync(path, backup)
}

function redact(message: string): string {
  return message.replace(
    /\b(api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|credential|private[-_ ]?key)\s*[:=]\s*[^\s,;]+/gi,
    '$1=[REDACTED]',
  )
}
