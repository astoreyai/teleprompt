import { app } from 'electron'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendDiagnosticLine } from './diagnostic-log.js'

function logFilePath(): string {
  for (const base of ['logs', 'userData'] as const) {
    try {
      return join(app.getPath(base), 'teleprompt-crash.log')
    } catch {
      /* getPath may be unavailable very early; try next */
    }
  }
  return join(tmpdir(), 'teleprompt-crash.log')
}

/**
 * Append a timestamped line to the crash log. Never throws — diagnostics must
 * not be able to take the app down.
 */
export function logCrash(message: string): void {
  try {
    appendDiagnosticLine(logFilePath(), message)
  } catch {
    /* last resort */
    console.error('[crash]', message)
  }
}

export function getCrashLogPath(): string {
  return logFilePath()
}
