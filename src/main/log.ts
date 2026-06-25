import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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
  const line = `${new Date().toISOString()} ${message}\n`
  try {
    const file = logFilePath()
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, line)
  } catch {
    /* last resort */
    console.error('[crash]', message)
  }
}

export function getCrashLogPath(): string {
  return logFilePath()
}
