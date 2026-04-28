import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { parseCues, stripCues } from '../../../shared/cues'
import type { AppState } from '../../../shared/types'

marked.setOptions({ gfm: true, breaks: true, async: false })

function useWindowDrag() {
  return useMemo(() => {
    const onMouseDown = (e: React.MouseEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      window.api.dragStart(e.screenX, e.screenY)
      const onMove = (ev: MouseEvent) => window.api.dragUpdate(ev.screenX, ev.screenY)
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        window.api.dragEnd()
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }
    return onMouseDown
  }, [])
}

function useWindowResize(edge: 'se' | 'sw' | 'ne' | 'nw' | 'n' | 's' | 'e' | 'w') {
  return useMemo(() => {
    const onMouseDown = (e: React.MouseEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      window.api.resizeStart(e.screenX, e.screenY, edge)
      const onMove = (ev: MouseEvent) => window.api.resizeUpdate(ev.screenX, ev.screenY)
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        window.api.resizeEnd()
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }
    return onMouseDown
  }, [edge])
}

const DISPATCH_INTERVAL_MS = 50
const ECHO_THRESHOLD = 0.0015

function renderMarkdown(src: string): string {
  try {
    const raw = marked.parse(src) as string
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })
  } catch {
    return DOMPurify.sanitize(src, { USE_PROFILES: { html: true } })
  }
}

function countWords(s: string): number {
  return (s.match(/[A-Za-z0-9À-ɏЀ-ӿ֐-׿؀-ۿ']+/g) || []).length
}

function fmtMMSS(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '--:--'
  const s = Math.floor(seconds)
  const m = Math.floor(s / 60)
  return `${m.toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`
}

function MiniTransport({ state }: { state: AppState }) {
  return (
    <div className="overlay__mini">
      <button
        className="overlay__btn"
        title="Restart from top"
        onClick={() => window.api.patchState({ scrollPosition: 0, playing: false })}
      >
        ↺
      </button>
      <button
        className="overlay__btn"
        title={state.playing ? 'Pause' : 'Play'}
        onClick={() => window.api.togglePlay()}
      >
        {state.playing ? '⏸' : '▶'}
      </button>
      <button
        className="overlay__btn"
        title="Open controls"
        aria-label="Open controls window"
        onClick={() => window.api.toggleControls()}
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
  const upcomingIdx = cues.findIndex((c) => c.position > scrollPosition + 0.001)
  const currentIdx =
    upcomingIdx === -1 ? cues.length - 1 : Math.max(0, upcomingIdx - 1)
  const visible = cues.slice(Math.max(0, currentIdx - 1), currentIdx + 4)
  return (
    <div className="cue-hud">
      {visible.map((c) => {
        const isCurrent = c.index === currentIdx && upcomingIdx !== 0
        const isPast = c.position <= scrollPosition && !isCurrent
        return (
          <div
            key={c.index}
            className={`cue-hud__row ${isCurrent ? 'cue-hud__row--current' : ''} ${isPast ? 'cue-hud__row--past' : ''}`}
          >
            <span className="cue-hud__num">{c.index + 1}</span>
            <span className="cue-hud__name">{c.name}</span>
          </div>
        )
      })}
    </div>
  )
}

function Chronometer({
  visible,
  playing,
  scrollPosition,
  scrollSpeed,
  textHeight,
  viewportHeight,
  wordCount,
  position,
  fileKey,
}: {
  visible: boolean
  playing: boolean
  scrollPosition: number
  scrollSpeed: number
  textHeight: number
  viewportHeight: number
  wordCount: number
  position: 'corner' | 'banner-top' | 'banner-bottom'
  fileKey: string
}) {
  const [elapsed, setElapsed] = useState(0)
  const [hidden, setHidden] = useState(typeof document !== 'undefined' && document.hidden)
  const tickRef = useRef<number>(0)
  const lastRef = useRef<number>(0)

  useEffect(() => {
    const onVis = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  useEffect(() => {
    if (!playing || hidden) {
      cancelAnimationFrame(tickRef.current)
      lastRef.current = 0
      return
    }
    const tick = (now: number) => {
      if (!lastRef.current) lastRef.current = now
      const dt = (now - lastRef.current) / 1000
      lastRef.current = now
      setElapsed((e) => e + dt)
      tickRef.current = requestAnimationFrame(tick)
    }
    tickRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(tickRef.current)
  }, [playing, hidden])

  useEffect(() => {
    if (scrollPosition === 0) setElapsed(0)
  }, [scrollPosition])

  useEffect(() => {
    setElapsed(0)
  }, [fileKey])

  if (!visible) return null

  const range = Math.max(1, textHeight - viewportHeight)
  const totalSec = range / Math.max(1, scrollSpeed)
  const remainingSec = (1 - scrollPosition) * totalSec
  const targetWpm = totalSec > 0 ? Math.round((wordCount * 60) / totalSec) : 0

  return (
    <div className={`chrono chrono--${position}`}>
      <span>⏱ {fmtMMSS(elapsed)}</span>
      <span className="chrono__sep">·</span>
      <span title="Time to end at current speed">→ {fmtMMSS(remainingSec)}</span>
      <span className="chrono__sep">·</span>
      <span title="Target words-per-minute at current speed">{targetWpm} wpm</span>
    </div>
  )
}

export function Overlay() {
  const [state, setState] = useState<AppState | null>(null)

  useEffect(() => {
    let unsub: (() => void) | undefined
    window.api.getState().then(setState)
    unsub = window.api.onState(setState)
    return () => unsub?.()
  }, [])

  if (!state) return null
  return state.bannerMode ? <BannerView state={state} /> : <FullView state={state} />
}

function FullView({ state }: { state: AppState }) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const liveRef = useRef(state)
  liveRef.current = state

  const localPosRef = useRef(state.scrollPosition)
  const lastSentRef = useRef(state.scrollPosition)
  const lastDispatchAtRef = useRef(0)
  const rafRef = useRef<number>(0)
  const lastTickRef = useRef<number>(0)

  const [geom, setGeom] = useState({ textH: 0, viewportH: 0 })
  const [countdown, setCountdown] = useState<number | null>(null)

  const file = state.files[state.currentFileIndex]
  const display = useMemo(() => (file ? stripCues(file.content) : ''), [file?.content])
  const cues = useMemo(() => (file ? parseCues(file.content) : []), [file?.content])
  const isMarkdownFile = file ? /\.(md|markdown)$/i.test(file.path) : false
  const renderAsMd = !!file && (state.markdown || isMarkdownFile)
  const html = useMemo(
    () => (renderAsMd ? renderMarkdown(display) : null),
    [display, renderAsMd],
  )
  const wordCount = useMemo(() => countWords(display), [display])

  const applyTransform = () => {
    if (!viewportRef.current || !textRef.current) return
    const viewportH = viewportRef.current.clientHeight
    const textH = textRef.current.scrollHeight
    const range = Math.max(1, textH - viewportH)
    const offset = -localPosRef.current * range
    const cur = liveRef.current
    const sx = cur.mirrorH ? -1 : 1
    const sy = cur.mirrorV ? -1 : 1
    textRef.current.style.transform = `translateY(${offset}px) scale(${sx}, ${sy})`
  }

  useLayoutEffect(() => {
    if (!viewportRef.current || !textRef.current) return
    const viewportH = viewportRef.current.clientHeight
    const textH = textRef.current.scrollHeight
    if (textH !== geom.textH || viewportH !== geom.viewportH) {
      setGeom({ textH, viewportH })
      window.api.reportOverlayGeom({ textH, viewportH })
    }
    applyTransform()
  }, [html, display, state.fontSize, state.fontFamily, state.mirrorH, state.mirrorV])

  useEffect(() => {
    if (Math.abs(state.scrollPosition - lastSentRef.current) > ECHO_THRESHOLD) {
      localPosRef.current = state.scrollPosition
      lastSentRef.current = state.scrollPosition
      applyTransform()
    }
  }, [state.scrollPosition])

  useEffect(() => {
    const viewport = viewportRef.current
    const text = textRef.current
    if (!viewport || !text) return
    const ro = new ResizeObserver(() => {
      const v = viewportRef.current
      const t = textRef.current
      if (!v || !t) return
      const viewportH = v.clientHeight
      const textH = t.scrollHeight
      setGeom((g) => (g.textH === textH && g.viewportH === viewportH ? g : { textH, viewportH }))
      window.api.reportOverlayGeom({ textH, viewportH })
      applyTransform()
    })
    ro.observe(viewport)
    ro.observe(text)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!state.playing) {
      cancelAnimationFrame(rafRef.current)
      lastTickRef.current = 0
      setCountdown(null)
      return
    }
    let cancelled = false
    let countdownTimer: ReturnType<typeof setTimeout> | null = null

    const startScroll = () => {
      if (cancelled) return
      setCountdown(null)
      lastTickRef.current = 0
      const tick = (now: number) => {
        const last = lastTickRef.current
        lastTickRef.current = now
        if (last === 0) {
          rafRef.current = requestAnimationFrame(tick)
          return
        }
        const dt = (now - last) / 1000
        const viewport = viewportRef.current
        const text = textRef.current
        if (viewport && text) {
          const range = Math.max(1, text.scrollHeight - viewport.clientHeight)
          const cur = liveRef.current
          const dPos = (cur.scrollSpeed * dt) / range
          const next = Math.min(1, localPosRef.current + dPos)
          localPosRef.current = next
          applyTransform()
          if (now - lastDispatchAtRef.current > DISPATCH_INTERVAL_MS || next >= 1) {
            lastSentRef.current = next
            lastDispatchAtRef.current = now
            window.api.setScrollPosition(next)
          }
          if (next >= 1) {
            lastTickRef.current = 0
            window.api.patchState({ playing: false })
            return
          }
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    const cur = liveRef.current
    if (cur.countdownEnabled && cur.countdownSeconds > 0 && cur.scrollPosition < 0.001) {
      let n = cur.countdownSeconds
      setCountdown(n)
      const step = () => {
        if (cancelled) return
        n -= 1
        if (n <= 0) {
          setCountdown(null)
          startScroll()
        } else {
          setCountdown(n)
          countdownTimer = setTimeout(step, 1000)
        }
      }
      countdownTimer = setTimeout(step, 1000)
    } else {
      startScroll()
    }

    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
      if (countdownTimer) clearTimeout(countdownTimer)
      setCountdown(null)
    }
  }, [state.playing])

  const overlayBg = { background: `rgba(0, 0, 0, ${state.bgDim})` }
  const textStyle: React.CSSProperties = {
    fontSize: `${state.fontSize}px`,
    fontFamily: state.fontFamily,
    color: state.fontColor,
  }
  const eyeLineTop = `${state.eyeLinePosition * 100}%`
  const cls = `overlay__text ${state.textShadow ? 'overlay__text--shadow' : ''} ${renderAsMd ? 'overlay__text--md' : ''}`

  const onTextDoubleClick = () => {
    if (!file) return
    window.api.patchState({ editMode: true, playing: false })
    window.api.focusControls()
  }

  const onDragMouseDown = useWindowDrag()
  const onResizeSE = useWindowResize('se')
  const onResizeSW = useWindowResize('sw')
  const onResizeNE = useWindowResize('ne')
  const onResizeNW = useWindowResize('nw')

  return (
    <div className="overlay">
      <div className="overlay__bg" style={overlayBg} />
      <div className="overlay__drag">
        <div className="overlay__drag-grip" onMouseDown={onDragMouseDown} />
        <MiniTransport state={state} />
      </div>
      <div className="overlay__resize overlay__resize--se" onMouseDown={onResizeSE} />
      <div className="overlay__resize overlay__resize--sw" onMouseDown={onResizeSW} />
      <div className="overlay__resize overlay__resize--ne" onMouseDown={onResizeNE} />
      <div className="overlay__resize overlay__resize--nw" onMouseDown={onResizeNW} />
      <div className="overlay__viewport" ref={viewportRef} onDoubleClick={onTextDoubleClick}>
        {file ? (
          html ? (
            <div
              ref={textRef}
              className={cls}
              style={textStyle}
              dir="auto"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <div ref={textRef} className={cls} style={textStyle} dir="auto">
              {display}
            </div>
          )
        ) : (
          <div className="overlay__placeholder">No script loaded — open a file from the Controls window</div>
        )}
      </div>

      {state.focusMode && (
        <>
          <div className="overlay__focus-mask" style={{ top: 0, height: `calc(${eyeLineTop} - 1.4em)` }} />
          <div
            className="overlay__focus-mask"
            style={{ top: `calc(${eyeLineTop} + 1.4em)`, bottom: 0, height: 'auto' }}
          />
        </>
      )}

      {state.showEyeLine && <div className="overlay__eyeline" style={{ top: eyeLineTop }} />}

      {countdown !== null && (
        <div className="overlay__countdown">{countdown}</div>
      )}

      {state.showCueHud && cues.length > 0 && (
        <CueHud cues={cues} scrollPosition={state.scrollPosition} />
      )}

      <Chronometer
        visible={state.showChronometer && !!file}
        playing={state.playing}
        scrollPosition={state.scrollPosition}
        scrollSpeed={state.scrollSpeed}
        textHeight={geom.textH}
        viewportHeight={geom.viewportH}
        wordCount={wordCount}
        position="corner"
        fileKey={file?.path ?? ''}
      />
    </div>
  )
}

function BannerView({ state }: { state: AppState }) {
  const stripRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const liveRef = useRef(state)
  liveRef.current = state

  const bannerDragDown = useWindowDrag()
  const bannerResizeSE = useWindowResize('se')
  const bannerResizeSW = useWindowResize('sw')
  const bannerResizeNE = useWindowResize('ne')
  const bannerResizeNW = useWindowResize('nw')

  const localPosRef = useRef(state.scrollPosition)
  const lastSentRef = useRef(state.scrollPosition)
  const lastDispatchAtRef = useRef(0)
  const rafRef = useRef<number>(0)
  const lastTickRef = useRef<number>(0)

  const file = state.files[state.currentFileIndex]
  const flat = useMemo(
    () => (file ? stripCues(file.content).replace(/\s+/g, ' ').trim() : ''),
    [file?.content],
  )

  const applyTransform = () => {
    if (!stripRef.current || !textRef.current) return
    const stripW = stripRef.current.clientWidth
    const textW = textRef.current.scrollWidth
    const range = Math.max(1, textW + stripW)
    const offset = stripW - localPosRef.current * range
    const cur = liveRef.current
    const sx = cur.mirrorH ? -1 : 1
    const sy = cur.mirrorV ? -1 : 1
    textRef.current.style.transform = `translateX(${offset}px) scale(${sx}, ${sy})`
  }

  useLayoutEffect(() => {
    applyTransform()
  }, [flat, state.fontSize, state.fontFamily, state.mirrorH, state.mirrorV])

  useEffect(() => {
    if (Math.abs(state.scrollPosition - lastSentRef.current) > ECHO_THRESHOLD) {
      localPosRef.current = state.scrollPosition
      lastSentRef.current = state.scrollPosition
      applyTransform()
    }
  }, [state.scrollPosition])

  useEffect(() => {
    if (!state.playing) {
      cancelAnimationFrame(rafRef.current)
      lastTickRef.current = 0
      return
    }
    const tick = (now: number) => {
      const last = lastTickRef.current
      lastTickRef.current = now
      if (last === 0) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      const dt = (now - last) / 1000
      const strip = stripRef.current
      const text = textRef.current
      if (strip && text) {
        const stripW = strip.clientWidth
        const textW = text.scrollWidth
        const range = Math.max(1, textW + stripW)
        const cur = liveRef.current
        const dPos = (cur.scrollSpeed * dt) / range
        const next = Math.min(1, localPosRef.current + dPos)
        localPosRef.current = next
        applyTransform()
        if (now - lastDispatchAtRef.current > DISPATCH_INTERVAL_MS || next >= 1) {
          lastSentRef.current = next
          lastDispatchAtRef.current = now
          window.api.setScrollPosition(next)
        }
        if (next >= 1) {
          lastTickRef.current = 0
          window.api.patchState({ playing: false })
          return
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [state.playing])

  const stripStyle: React.CSSProperties = {
    background: `rgba(0, 0, 0, ${state.bgDim})`,
    fontSize: `${state.fontSize}px`,
    fontFamily: state.fontFamily,
    color: state.fontColor,
  }
  const wrapStyle: React.CSSProperties =
    state.bannerPosition === 'top' ? { top: 0, bottom: 'auto' } : { top: 'auto', bottom: 0 }

  return (
    <div className="overlay overlay--banner">
      <div className="overlay__drag">
        <div className="overlay__drag-grip" onMouseDown={bannerDragDown} />
        <MiniTransport state={state} />
      </div>
      <div className="overlay__resize overlay__resize--se" onMouseDown={bannerResizeSE} />
      <div className="overlay__resize overlay__resize--sw" onMouseDown={bannerResizeSW} />
      <div className="overlay__resize overlay__resize--ne" onMouseDown={bannerResizeNE} />
      <div className="overlay__resize overlay__resize--nw" onMouseDown={bannerResizeNW} />
      <div className={`banner ${state.textShadow ? 'banner--shadow' : ''}`} style={{ ...wrapStyle, ...stripStyle }} ref={stripRef}>
        {file ? (
          <div ref={textRef} className="banner__text" dir="auto">
            {flat}
          </div>
        ) : (
          <div className="overlay__placeholder" style={{ position: 'static' }}>
            No script loaded
          </div>
        )}
      </div>
    </div>
  )
}
