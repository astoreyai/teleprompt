import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { parseCues, stripCues } from '../../../shared/cues'
import type { DocumentContent, OverlayDocumentMeta, OverlaySnapshot } from '../../../shared/contracts'
import { countWords } from '../../../shared/text'
import { PlaybackCheckpointGate } from '../shared/checkpoint-gate'
import { shouldRenderMarkdown } from '../shared/render-policy'

marked.setOptions({ gfm: true, breaks: true, async: false })

type ResizeEdge = 'se' | 'sw' | 'ne' | 'nw' | 'n' | 's' | 'e' | 'w'

function useWindowGesture(edge?: ResizeEdge) {
  const cleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => cleanup.current?.(), [])
  return (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    cleanup.current?.()
    event.preventDefault()
    event.stopPropagation()
    const element = event.currentTarget
    const pointerId = event.pointerId
    element.setPointerCapture(pointerId)
    const safe = (operation: Promise<void>) => { void operation.catch(() => finish()) }
    const onMove = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return
      safe(edge ? window.overlayApi.resizeUpdate(next.screenX, next.screenY) : window.overlayApi.dragUpdate(next.screenX, next.screenY))
    }
    const finish = () => {
      if (cleanup.current !== finish) return
      cleanup.current = null
      element.removeEventListener('pointermove', onMove)
      element.removeEventListener('pointerup', onEnd)
      element.removeEventListener('pointercancel', onEnd)
      element.removeEventListener('lostpointercapture', finish)
      window.removeEventListener('blur', finish)
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId)
      void (edge ? window.overlayApi.resizeEnd() : window.overlayApi.dragEnd()).catch(() => undefined)
    }
    const onEnd = (next: PointerEvent) => { if (next.pointerId === pointerId) finish() }
    cleanup.current = finish
    element.addEventListener('pointermove', onMove)
    element.addEventListener('pointerup', onEnd)
    element.addEventListener('pointercancel', onEnd)
    element.addEventListener('lostpointercapture', finish)
    window.addEventListener('blur', finish)
    safe(edge ? window.overlayApi.resizeStart(event.screenX, event.screenY, edge) : window.overlayApi.dragStart(event.screenX, event.screenY))
  }
}

function useWindowDrag() { return useWindowGesture() }
function useWindowResize(edge: ResizeEdge) { return useWindowGesture(edge) }

function renderMarkdown(source: string): string {
  try {
    return DOMPurify.sanitize(marked.parse(source) as string, { USE_PROFILES: { html: true } })
  } catch {
    return DOMPurify.sanitize(source, { USE_PROFILES: { html: true } })
  }
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}`
}

function MiniTransport({ snapshot }: { snapshot: OverlaySnapshot }) {
  return (
    <div className="overlay__mini" aria-label="Playback controls">
      <button
        className="overlay__btn"
        title={snapshot.playing ? 'Pause' : 'Play'}
        aria-label={snapshot.playing ? 'Pause' : 'Play'}
        onClick={() => void window.overlayApi.togglePlayback()}
      >
        {snapshot.playing ? '⏸' : '▶'}
      </button>
      <button
        className="overlay__btn"
        title="Open controls"
        aria-label="Open controls window"
        onClick={() => void window.overlayApi.focusControls()}
      >
        ⚙
      </button>
    </div>
  )
}

function CueHud({
  cues,
  scrollPosition,
}: {
  cues: { name: string; position: number; index: number }[]
  scrollPosition: number
}) {
  const upcomingIndex = cues.findIndex((cue) => cue.position > scrollPosition + 0.001)
  const currentIndex = upcomingIndex === -1 ? cues.length - 1 : Math.max(0, upcomingIndex - 1)
  const visible = cues.slice(Math.max(0, currentIndex - 1), currentIndex + 4)
  return (
    <div className="cue-hud" aria-label="Cue points">
      {visible.map((cue) => {
        const current = cue.index === currentIndex && upcomingIndex !== 0
        const past = cue.position <= scrollPosition && !current
        return (
          <div
            key={cue.index}
            className={`cue-hud__row ${current ? 'cue-hud__row--current' : ''} ${past ? 'cue-hud__row--past' : ''}`}
          >
            <span className="cue-hud__num">{cue.index + 1}</span>
            <span className="cue-hud__name">{cue.name}</span>
          </div>
        )
      })}
    </div>
  )
}

function Chronometer({
  snapshot,
  scrollPosition,
  textHeight,
  viewportHeight,
  wordCount,
  documentId,
}: {
  snapshot: OverlaySnapshot
  scrollPosition: number
  textHeight: number
  viewportHeight: number
  wordCount: number
  documentId: string
}) {
  const [elapsed, setElapsed] = useState(0)
  const last = useRef(0)

  useEffect(() => {
    setElapsed(0)
  }, [documentId])

  useEffect(() => {
    if (!snapshot.playing) {
      last.current = 0
      return
    }
    last.current = performance.now()
    const timer = setInterval(() => {
      const now = performance.now()
      if (document.hidden) {
        last.current = now
      } else {
        setElapsed((value) => value + (now - last.current) / 1000)
        last.current = now
      }
    }, 250)
    return () => clearInterval(timer)
  }, [snapshot.playing])

  if (!snapshot.showChronometer) return null
  const range = Math.max(1, textHeight - viewportHeight)
  const totalSeconds = range / Math.max(1, snapshot.scrollSpeed)
  const remaining = (1 - scrollPosition) * totalSeconds
  const wordsPerMinute = totalSeconds > 0 ? Math.round((wordCount * 60) / totalSeconds) : 0
  return (
    <div className="chrono chrono--corner" aria-live="off">
      <span>⏱ {formatTime(elapsed)}</span>
      <span className="chrono__sep">·</span>
      <span title="Estimated time to end">→ {formatTime(remaining)}</span>
      <span className="chrono__sep">·</span>
      <span>{wordsPerMinute} wpm</span>
    </div>
  )
}

export function Overlay() {
  const [snapshot, setSnapshot] = useState<OverlaySnapshot | null>(null)
  const [documentContent, setDocumentContent] = useState<DocumentContent | null>(null)
  const [startupError, setStartupError] = useState<string | null>(null)

  useEffect(() => {
    const unsubscribeSnapshot = window.overlayApi.onSnapshot(setSnapshot)
    const unsubscribeDocument = window.overlayApi.onActiveDocument(setDocumentContent)
    void window.overlayApi
      .bootstrap()
      .then((payload) => {
        setSnapshot(payload.snapshot)
        setDocumentContent(payload.activeDocument)
        setStartupError(payload.hasStartupIssues ? 'Some documents could not be restored. Open Controls for details.' : null)
      })
      .catch((error: unknown) => {
        setStartupError(error instanceof Error ? error.message : 'Overlay failed to initialize')
      })
    return () => {
      unsubscribeSnapshot()
      unsubscribeDocument()
    }
  }, [])

  if (!snapshot) {
    return startupError ? <div className="overlay__fatal">{startupError}</div> : null
  }
  const metadata = snapshot.activeDocumentMeta
  const content = documentContent?.id === metadata?.id ? documentContent : null
  return snapshot.bannerMode ? (
    <BannerView snapshot={snapshot} metadata={metadata} content={content} />
  ) : (
    <FullView snapshot={snapshot} metadata={metadata} content={content} startupError={startupError} />
  )
}

type ViewProps = {
  snapshot: OverlaySnapshot
  metadata: OverlayDocumentMeta | null
  content: DocumentContent | null
}

function usePlaybackCheckpoint(
  snapshot: OverlaySnapshot,
  content: DocumentContent | null,
  localPosition: React.MutableRefObject<number>,
) {
  const gate = useRef(new PlaybackCheckpointGate(250, 0.05))
  const current = useRef({ snapshot, content })
  current.current = { snapshot, content }
  useLayoutEffect(() => {
    gate.current.reset()
  }, [snapshot.playbackSessionId, snapshot.seekGeneration, content?.id, content?.revision])

  return (position: number, terminal: boolean, now: number) => {
    const { snapshot: latest, content: document } = current.current
    if (!latest.playbackSessionId || !document) return
    localPosition.current = position
    if (!gate.current.shouldSend({ now, position, terminal })) return
    void window.overlayApi.checkpoint({
      documentId: document.id,
      revision: document.revision,
      sessionId: latest.playbackSessionId,
      seekGeneration: latest.seekGeneration,
      position,
      terminal,
    }).catch(() => undefined)
  }
}

function FullView({
  snapshot,
  metadata,
  content,
  startupError,
}: ViewProps & { startupError: string | null }) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const liveSnapshot = useRef(snapshot)
  liveSnapshot.current = snapshot
  const localPosition = useRef(snapshot.scrollPosition)
  const frame = useRef(0)
  const lastTick = useRef(0)
  const [geometry, setGeometry] = useState({ textH: 0, viewportH: 0 })
  const geometryRef = useRef(geometry)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [renderedPosition, setRenderedPosition] = useState(snapshot.scrollPosition)
  const visualUpdateGate = useRef(new PlaybackCheckpointGate(250))
  const checkpoint = usePlaybackCheckpoint(snapshot, content, localPosition)

  const display = useMemo(() => stripCues(content?.content ?? ''), [content?.content])
  const cues = useMemo(() => parseCues(content?.content ?? ''), [content?.content])
  const renderAsMarkdown = !!content && shouldRenderMarkdown(
    display.length,
    snapshot.markdown,
    metadata?.format,
  )
  const html = useMemo(
    () => (renderAsMarkdown ? renderMarkdown(display) : null),
    [display, renderAsMarkdown],
  )
  const wordCount = useMemo(() => countWords(display), [display])

  const applyTransform = () => {
    const viewport = viewportRef.current
    const text = textRef.current
    if (!viewport || !text) return
    const range = Math.max(1, geometryRef.current.textH - geometryRef.current.viewportH)
    const offset = -localPosition.current * range
    const current = liveSnapshot.current
    text.style.transform = `translateY(${offset}px) scale(${current.mirrorH ? -1 : 1}, ${current.mirrorV ? -1 : 1})`
  }

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const text = textRef.current
    if (!viewport || !text || !content) {
      geometryRef.current = { textH: 0, viewportH: 0 }
      setGeometry(geometryRef.current)
      return
    }
    const measure = () => {
      const next = { textH: text.scrollHeight, viewportH: viewport.clientHeight }
      geometryRef.current = next
      setGeometry((previous) => previous.textH === next.textH && previous.viewportH === next.viewportH ? previous : next)
      void window.overlayApi.reportGeometry({ ...next, documentId: content.id, revision: content.revision, bannerMode: false }).catch(() => undefined)
      applyTransform()
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(text)
    return () => observer.disconnect()
  }, [content?.id, content?.revision, html, display, snapshot.fontSize, snapshot.fontFamily, snapshot.mirrorH, snapshot.mirrorV])

  useEffect(() => {
    visualUpdateGate.current.reset()
  }, [snapshot.playbackSessionId, content?.id, content?.revision])

  useLayoutEffect(() => {
    localPosition.current = snapshot.scrollPosition
    setRenderedPosition(snapshot.scrollPosition)
    applyTransform()
  }, [snapshot.seekGeneration, snapshot.playbackSessionId, content?.id, content?.revision, snapshot.playing, snapshot.playing ? null : snapshot.scrollPosition])

  useEffect(() => {
    if (!snapshot.playing || !snapshot.playbackSessionId || !content) {
      cancelAnimationFrame(frame.current)
      lastTick.current = 0
      setCountdown(null)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const start = () => {
      if (cancelled) return
      setCountdown(null)
      lastTick.current = 0
      const tick = (now: number) => {
        const previous = lastTick.current
        lastTick.current = now
        if (previous) {
          const viewport = viewportRef.current
          const text = textRef.current
          if (viewport && text) {
            const range = Math.max(1, geometryRef.current.textH - geometryRef.current.viewportH)
            const next = Math.min(
              1,
              localPosition.current + (liveSnapshot.current.scrollSpeed * (now - previous)) / 1000 / range,
            )
            localPosition.current = next
            if (visualUpdateGate.current.shouldSend({ now, position: next, terminal: next >= 1 })) {
              setRenderedPosition(next)
            }
            applyTransform()
            checkpoint(next, next >= 1, now)
            if (next >= 1) return
          }
        }
        frame.current = requestAnimationFrame(tick)
      }
      frame.current = requestAnimationFrame(tick)
    }

    if (snapshot.countdownEnabled && snapshot.countdownSeconds > 0 && localPosition.current < 0.001) {
      let remaining = snapshot.countdownSeconds
      setCountdown(remaining)
      const step = () => {
        if (cancelled) return
        remaining -= 1
        if (remaining <= 0) start()
        else {
          setCountdown(remaining)
          timer = setTimeout(step, 1000)
        }
      }
      timer = setTimeout(step, 1000)
    } else {
      start()
    }

    return () => {
      cancelled = true
      cancelAnimationFrame(frame.current)
      if (timer) clearTimeout(timer)
    }
  }, [snapshot.playing, snapshot.playbackSessionId, content?.id, content?.revision])

  const textStyle: React.CSSProperties = {
    fontSize: `${snapshot.fontSize}px`,
    fontFamily: snapshot.fontFamily,
    color: snapshot.fontColor,
  }
  const eyeLineTop = `${snapshot.eyeLinePosition * 100}%`
  const className = `overlay__text ${snapshot.textShadow ? 'overlay__text--shadow' : ''} ${renderAsMarkdown ? 'overlay__text--md' : ''}`
  const drag = useWindowDrag()
  const resizeSE = useWindowResize('se')
  const resizeSW = useWindowResize('sw')
  const resizeNE = useWindowResize('ne')
  const resizeNW = useWindowResize('nw')

  return (
    <div className="overlay">
      <div className="overlay__bg" style={{ background: `rgba(0, 0, 0, ${snapshot.bgDim})` }} />
      <div className="overlay__drag">
        <div className="overlay__drag-grip" onPointerDown={drag} />
        <MiniTransport snapshot={snapshot} />
      </div>
      <div className="overlay__resize overlay__resize--se" onPointerDown={resizeSE} />
      <div className="overlay__resize overlay__resize--sw" onPointerDown={resizeSW} />
      <div className="overlay__resize overlay__resize--ne" onPointerDown={resizeNE} />
      <div className="overlay__resize overlay__resize--nw" onPointerDown={resizeNW} />
      <div
        className="overlay__viewport"
        ref={viewportRef}
        onDoubleClick={() => content && void window.overlayApi.openEditor()}
      >
        {content ? (
          html ? (
            <div
              ref={textRef}
              className={className}
              style={textStyle}
              dir="auto"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <div ref={textRef} className={className} style={textStyle} dir="auto">
              {display}
            </div>
          )
        ) : (
          <div className="overlay__placeholder">
            {startupError ?? 'No script loaded — open a file from Controls'}
          </div>
        )}
      </div>
      {snapshot.focusMode && (
        <>
          <div className="overlay__focus-mask" style={{ top: 0, height: `calc(${eyeLineTop} - 1.4em)` }} />
          <div className="overlay__focus-mask" style={{ top: `calc(${eyeLineTop} + 1.4em)`, bottom: 0, height: 'auto' }} />
        </>
      )}
      {snapshot.showEyeLine && <div className="overlay__eyeline" style={{ top: eyeLineTop }} />}
      {countdown !== null && <div className="overlay__countdown">{countdown}</div>}
      {snapshot.showCueHud && cues.length > 0 && (
        <CueHud cues={cues} scrollPosition={renderedPosition} />
      )}
      {content && (
        <Chronometer
          snapshot={snapshot}
          scrollPosition={renderedPosition}
          textHeight={geometry.textH}
          viewportHeight={geometry.viewportH}
          wordCount={wordCount}
          documentId={content.id}
        />
      )}
    </div>
  )
}

function BannerView({ snapshot, metadata: _metadata, content }: ViewProps) {
  const stripRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const liveSnapshot = useRef(snapshot)
  liveSnapshot.current = snapshot
  const localPosition = useRef(snapshot.scrollPosition)
  const geometryRef = useRef({ range: 1, viewportWidth: 0 })
  const frame = useRef(0)
  const lastTick = useRef(0)
  const checkpoint = usePlaybackCheckpoint(snapshot, content, localPosition)
  const flat = useMemo(
    () => stripCues(content?.content ?? '').replace(/\s+/g, ' ').trim(),
    [content?.content],
  )

  const applyTransform = () => {
    const strip = stripRef.current
    const text = textRef.current
    if (!strip || !text) return
    const range = geometryRef.current.range
    const offset = geometryRef.current.viewportWidth - localPosition.current * range
    const current = liveSnapshot.current
    text.style.transform = `translateX(${offset}px) scale(${current.mirrorH ? -1 : 1}, ${current.mirrorV ? -1 : 1})`
  }

  useLayoutEffect(() => {
    const strip = stripRef.current
    const text = textRef.current
    if (!strip || !text || !content) return
    const measure = () => {
      const range = Math.max(1, text.scrollWidth + strip.clientWidth)
      geometryRef.current = { range, viewportWidth: strip.clientWidth }
      void window.overlayApi.reportGeometry({ textH: range, viewportH: 0, documentId: content.id, revision: content.revision, bannerMode: true }).catch(() => undefined)
      applyTransform()
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(strip)
    observer.observe(text)
    return () => observer.disconnect()
  }, [content?.id, content?.revision, flat, snapshot.fontSize, snapshot.fontFamily, snapshot.mirrorH, snapshot.mirrorV])

  useLayoutEffect(() => {
    localPosition.current = snapshot.scrollPosition
    applyTransform()
  }, [snapshot.seekGeneration, snapshot.playbackSessionId, content?.id, content?.revision, snapshot.playing, snapshot.playing ? null : snapshot.scrollPosition])

  useEffect(() => {
    if (!snapshot.playing || !snapshot.playbackSessionId || !content) {
      cancelAnimationFrame(frame.current)
      lastTick.current = 0
      return
    }
    const tick = (now: number) => {
      const previous = lastTick.current
      lastTick.current = now
      if (previous) {
        const strip = stripRef.current
        const text = textRef.current
        if (strip && text) {
          const range = geometryRef.current.range
          const next = Math.min(
            1,
            localPosition.current + (liveSnapshot.current.scrollSpeed * (now - previous)) / 1000 / range,
          )
          localPosition.current = next
          applyTransform()
          checkpoint(next, next >= 1, now)
          if (next >= 1) return
        }
      }
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [snapshot.playing, snapshot.playbackSessionId, content?.id, content?.revision])

  const drag = useWindowDrag()
  const resizeSE = useWindowResize('se')
  const resizeSW = useWindowResize('sw')
  const resizeNE = useWindowResize('ne')
  const resizeNW = useWindowResize('nw')
  const edgeStyle: React.CSSProperties =
    snapshot.bannerPosition === 'top' ? { top: 0, bottom: 'auto' } : { top: 'auto', bottom: 0 }

  return (
    <div className="overlay overlay--banner">
      <div className="overlay__drag">
        <div className="overlay__drag-grip" onPointerDown={drag} />
        <MiniTransport snapshot={snapshot} />
      </div>
      <div className="overlay__resize overlay__resize--se" onPointerDown={resizeSE} />
      <div className="overlay__resize overlay__resize--sw" onPointerDown={resizeSW} />
      <div className="overlay__resize overlay__resize--ne" onPointerDown={resizeNE} />
      <div className="overlay__resize overlay__resize--nw" onPointerDown={resizeNW} />
      <div
        className={`banner ${snapshot.textShadow ? 'banner--shadow' : ''}`}
        style={{
          ...edgeStyle,
          background: `rgba(0, 0, 0, ${snapshot.bgDim})`,
          fontSize: `${snapshot.fontSize}px`,
          fontFamily: snapshot.fontFamily,
          color: snapshot.fontColor,
        }}
        ref={stripRef}
      >
        {content ? (
          <div ref={textRef} className="banner__text" dir="auto" onDoubleClick={() => void window.overlayApi.openEditor()}>
            {flat}
          </div>
        ) : (
          <div className="overlay__placeholder" style={{ position: 'static' }}>No script loaded</div>
        )}
      </div>
    </div>
  )
}
