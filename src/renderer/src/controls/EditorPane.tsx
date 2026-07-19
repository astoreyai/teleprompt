import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { DocumentContent, DocumentMeta } from '../../../shared/contracts'

export type EditorHandle = {
  flush(): Promise<boolean>
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
  const localRef = useRef(documentContent.content)
  const revisionRef = useRef(documentContent.revision)
  const lastSubmitted = useRef(documentContent.content)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const queue = useRef<Promise<boolean>>(Promise.resolve(true))

  useEffect(() => {
    revisionRef.current = Math.max(revisionRef.current, documentContent.revision)
    if (localRef.current === lastSubmitted.current) {
      localRef.current = documentContent.content
      lastSubmitted.current = documentContent.content
      setLocal(documentContent.content)
    }
  }, [documentContent.content, documentContent.revision])

  const submit = (value: string): Promise<boolean> => {
    queue.current = queue.current.then(async () => {
      if (value === lastSubmitted.current) return true
      const result = await window.controlsApi.updateDocument(
        documentContent.id,
        revisionRef.current,
        value,
      )
      if (result.ok) {
        revisionRef.current = result.revision
        lastSubmitted.current = value
        return true
      }
      if (result.reason === 'conflict') {
        revisionRef.current = result.currentRevision
        onIssue('The script changed elsewhere. Your text is preserved; save again to retry against the latest revision.')
      } else if (result.reason === 'too-large') {
        onIssue('This script exceeds the 10 MB editing limit.')
      } else {
        onIssue('The active script is no longer available.')
      }
      return false
    }).catch((error: unknown) => {
      onIssue(error instanceof Error ? error.message : 'Unable to save the recovery draft')
      return false
    })
    return queue.current
  }

  const flush = async (): Promise<boolean> => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current)
      debounceTimer.current = null
    }
    return submit(localRef.current)
  }

  useImperativeHandle(ref, () => ({ flush }))

  useEffect(
    () => () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      if (localRef.current !== lastSubmitted.current) void submit(localRef.current)
    },
    [],
  )

  const updateLocal = (value: string) => {
    localRef.current = value
    setLocal(value)
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
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
      <textarea
        className="editor__area"
        aria-label={`Edit ${metadata.name}`}
        value={local}
        onChange={(event) => updateLocal(event.target.value)}
        onBlur={() => void flush()}
        spellCheck
        placeholder="Type your script…"
      />
    </section>
  )
})
