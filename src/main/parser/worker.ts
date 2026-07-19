import type { DocumentFormat } from '../../shared/contracts.js'
import { parseDocumentBytes } from './parser-core.js'

const port = process.parentPort
if (!port) throw new Error('parser worker requires an Electron utility-process parent')

port.once('message', async (event) => {
  const request = asRecord(event.data)
  if (
    !request ||
    !isDocumentFormat(request.format) ||
    !(request.bytes instanceof Uint8Array) ||
    typeof request.maxOutputChars !== 'number' ||
    !Number.isSafeInteger(request.maxOutputChars) ||
    request.maxOutputChars < 1
  ) {
    port.postMessage({ ok: false, error: 'invalid parser request' })
    return
  }
  try {
    const content = await parseDocumentBytes(request.format, request.bytes, {
      maxOutputChars: request.maxOutputChars,
    })
    port.postMessage({ ok: true, content })
  } catch (error) {
    port.postMessage({
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 500) : 'document parsing failed',
    })
  }
})

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function isDocumentFormat(value: unknown): value is DocumentFormat {
  return (
    value === 'text' ||
    value === 'markdown' ||
    value === 'fountain' ||
    value === 'rtf' ||
    value === 'docx' ||
    value === 'odt' ||
    value === 'pdf' ||
    value === 'html' ||
    value === 'subtitle'
  )
}
