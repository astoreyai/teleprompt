import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { DocumentContent, DocumentMeta } from '../../../shared/contracts'

export type EditorHandle = {
  flush(): Promise<boolean>
  suspend(): Promise<void>
  resume(content?: DocumentContent): void
}

export const EditorPane = forwardRef<
  EditorHandle,
  {
    metadata: DocumentMeta
    documentContent: DocumentContent
    saveMessage: string | null
    onSaveAfterFlush: () => Promise<void>
    onCloseAfterFlush: () => Promise<void>
    onIssue: (message: string) => void
  }
>(function EditorPane(
  { metadata, documentContent, saveMessage, onSaveAfterFlush, onCloseAfterFlush, onIssue },
  ref,
) {
  const [local, setLocal] = useState(documentContent.content)
  const [conflict, setConflict] = useState(false)
  const [suspended, setSuspended] = useState(false)
  const localRef = useRef(documentContent.content)
  const base = useRef(documentContent)
  const incoming = useRef(documentContent)
  incoming.current = documentContent
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlight = useRef<Promise<boolean> | null>(null)
  const pending = useRef<string | null>(null)
  const blocked = useRef(false)
  const paused = useRef(false)
  const generation = useRef(0)

  const clearTimer = () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = null
  }

  const reset = (content: DocumentContent) => {
    base.current = content
    localRef.current = content.content
    pending.current = null
    blocked.current = false
    setConflict(false)
    setLocal(content.content)
  }

  useEffect(() => {
    if (paused.current || inFlight.current || documentContent.revision <= base.current.revision) return
    if (localRef.current === base.current.content) reset(documentContent)
    else {
      blocked.current = true
      pending.current = null
      setConflict(true)
    }
  }, [documentContent.content, documentContent.revision])

  const submit = (value: string): Promise<boolean> => {
    if (paused.current || blocked.current) return Promise.resolve(false)
    pending.current = value
    if (inFlight.current) return inFlight.current
    const currentGeneration = generation.current
    const drain = async (): Promise<boolean> => {
      while (pending.current !== null && !blocked.current && !paused.current) {
        const next = pending.current
        pending.current = null
        if (next === base.current.content) continue
        try {
          const result = await window.controlsApi.updateDocument(documentContent.id, base.current.revision, next)
          if (currentGeneration !== generation.current) {
            // A reload may cancel pending work, but an admitted durable write still advances our base.
            if (result.ok) base.current = { id: documentContent.id, revision: result.revision, content: next }
            return false
          }
          if (result.ok) {
            base.current = { id: documentContent.id, revision: result.revision, content: next }
            if (incoming.current.revision > result.revision) {
              blocked.current = true
              pending.current = null
              setConflict(true)
              return false
            }
          } else {
            pending.current = null
            if (result.reason === 'conflict') {
              blocked.current = true
              setConflict(true)
              onIssue('The script changed elsewhere. Choose which version to keep; your text is preserved below.')
            } else if (result.reason === 'too-large') {
              onIssue('This script exceeds the 10 MB editing limit.')
            } else {
              onIssue('error' in result ? String(result.error) : 'The active script is no longer available.')
            }
            return false
          }
        } catch (error) {
          pending.current = null
          onIssue(error instanceof Error ? error.message : 'Unable to save the recovery draft')
          return false
        }
      }
      return !blocked.current && !paused.current
    }
    inFlight.current = drain().finally(() => { inFlight.current = null })
    return inFlight.current
  }

  const flush = async (): Promise<boolean> => {
    clearTimer()
    return submit(localRef.current)
  }

  useImperativeHandle(ref, () => ({
    flush,
    suspend: async () => {
      clearTimer()
      paused.current = true
      setSuspended(true)
      generation.current += 1
      pending.current = null
      await inFlight.current
    },
    resume: (content) => {
      if (content) reset(content)
      else if (incoming.current.revision > base.current.revision) {
        if (localRef.current === base.current.content) reset(incoming.current)
        else { blocked.current = true; setConflict(true) }
      }
      paused.current = false
      setSuspended(false)
    },
  }))

  useEffect(() => {
    paused.current = false
    return () => {
      clearTimer()
      paused.current = true
      generation.current += 1
      pending.current = null
    }
  }, [])

  const updateLocal = (value: string) => {
    localRef.current = value
    setLocal(value)
    clearTimer()
    if (inFlight.current && !blocked.current) pending.current = value
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null
      void submit(localRef.current)
    }, 200)
  }

  return (
    <section className="editor" aria-label="Script editor">
      <div className="editor__header">
        <span>
          Editing <strong>{metadata.name}</strong>
          {metadata.dirty && <span className="editor__dirty"> — recovery draft</span>}
        </span>
        <span className="editor__spacer" />
        {saveMessage && <span className="editor__msg" role="status">{saveMessage}</span>}
        <button
          type="button"
          className="btn"
          onClick={async () => {
            if (await flush()) await onSaveAfterFlush()
          }}
        >
          {metadata.saveMode === 'save-as' ? 'Save As…' : 'Save'}
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={async () => {
            if (await flush()) await onCloseAfterFlush()
          }}
        >
          Close editor
        </button>
      </div>
      {conflict && (
        <div className="banner-warn" role="alert">
          <p>The script changed elsewhere. Your text is preserved in the editor.</p>
          <details><summary>Review the current saved version</summary><pre>{documentContent.content}</pre></details>
          <button type="button" className="btn" onClick={() => reset(incoming.current)}>Use current saved version</button>
          <button type="button" className="btn" onClick={() => {
            base.current = incoming.current
            blocked.current = false
            setConflict(false)
            void flush()
          }}>Replace saved version with my text</button>
        </div>
      )}
      <textarea
        className="editor__area"
        aria-label={`Edit ${metadata.name}`}
        value={local}
        disabled={suspended}
        onChange={(event) => updateLocal(event.target.value)}
        onBlur={() => void flush()}
        spellCheck
        placeholder="Type your script…"
      />
    </section>
  )
})
