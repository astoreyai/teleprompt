import { useEffect, useMemo, useRef, useState } from 'react'
import { parseCues, stripCues } from '../../../shared/cues'
import type { AppState, BannerPosition, HotkeyCommand, ScriptFile } from '../../../shared/types'
import { DEFAULT_HOTKEYS, HOTKEY_LABELS } from '../../../shared/types'
import { EXAMPLES } from '../shared/examples'
import { tokenize, indexOfFirstTokenAtOrAfterChar, VoicePacer, type Token } from '../shared/voice'

export function Controls() {
  const [state, setState] = useState<AppState | null>(null)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [failedHotkeys, setFailedHotkeys] = useState<string[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const [platform, setPlatform] = useState<{
    platform: NodeJS.Platform
    displayServer: string
    contentProtectionSupported: boolean
  } | null>(null)
  const [presentationStatus, setPresentationStatus] = useState<{ ok: boolean; reason?: string } | null>(null)
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)
  const [overlayGeom, setOverlayGeom] = useState<{ textH: number; viewportH: number }>({
    textH: 0,
    viewportH: 0,
  })
  const stateRef = useRef<AppState | null>(null)
  const pacerRef = useRef<VoicePacer | null>(null)

  useEffect(() => {
    let unsub: (() => void) | undefined
    window.api.getState().then(setState)
    unsub = window.api.onState(setState)
    window.api.getHotkeyStatus().then((s) => setFailedHotkeys(s.failed))
    window.api.getPlatformInfo().then(setPlatform)
    window.api.getPresentationStatus().then(setPresentationStatus)
    const unsubGeom = window.api.onOverlayGeom(setOverlayGeom)
    return () => {
      unsub?.()
      unsubGeom()
    }
  }, [])

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const tokens = useMemo<Token[]>(() => {
    const file = state?.files[state.currentFileIndex]
    return file ? tokenize(stripCues(file.content)) : []
  }, [state?.currentFileIndex, state?.files])

  const cues = useMemo(() => {
    const file = state?.files[state.currentFileIndex]
    return file ? parseCues(file.content) : []
  }, [state?.currentFileIndex, state?.files])

  useEffect(() => () => pacerRef.current?.stop(), [])

  useEffect(() => {
    if (!state) return
    if (state.voicePacing) {
      if (!pacerRef.current) {
        pacerRef.current = new VoicePacer(
          () => {
            const cur = stateRef.current
            const f = cur?.files[cur.currentFileIndex]
            return f ? tokenize(stripCues(f.content)) : []
          },
          () => {
            const cur = stateRef.current
            if (!cur) return 0
            const file = cur.files[cur.currentFileIndex]
            if (!file) return 0
            const stripped = stripCues(file.content)
            const all = tokenize(stripped)
            const charPos = Math.floor(cur.scrollPosition * stripped.length)
            return indexOfFirstTokenAtOrAfterChar(all, charPos)
          },
          (tokenIdx) => {
            const cur = stateRef.current
            if (!cur) return
            const file = cur.files[cur.currentFileIndex]
            if (!file) return
            const stripped = stripCues(file.content)
            const all = tokenize(stripped)
            const tok = all[Math.min(tokenIdx, all.length - 1)]
            if (!tok) return
            const next = Math.min(1, tok.start / Math.max(1, stripped.length))
            window.api.setScrollPosition(next)
          },
          (msg) => setVoiceError(msg),
        )
      }
      const ok = pacerRef.current.start()
      if (!ok) window.api.patchState({ voicePacing: false })
    } else {
      pacerRef.current?.stop()
      setVoiceError(null)
    }
  }, [state?.voicePacing, tokens.length])

  const showToast = (msg: string, ms = 4000) => {
    setToast(msg)
    setTimeout(() => setToast((t) => (t === msg ? null : t)), ms)
  }

  const handleFiles = async (files: File[]) => {
    const errors: string[] = []
    for (const f of files) {
      let path = ''
      try {
        path = window.api.getPathForFile(f) || ''
      } catch {
        path = ''
      }
      if (path) {
        const r = await window.api.loadFromPath(path)
        if (r.ok) continue
        errors.push(`${f.name}: ${r.error}`)
      }
      if (f.size > 10 * 1024 * 1024) {
        errors.push(`${f.name}: too large (drag-drop cap 10MB)`)
        continue
      }
      try {
        const content = await f.text()
        await window.api.loadFromContent(f.name, content)
      } catch (err) {
        errors.push(`${f.name}: ${err instanceof Error ? err.message : 'read failed'}`)
      }
    }
    if (errors.length) showToast(errors.join(' • '))
  }

  useEffect(() => {
    const swallow = (e: DragEvent) => e.preventDefault()
    document.addEventListener('dragover', swallow)
    return () => document.removeEventListener('dragover', swallow)
  }, [])

  if (!state) return <div className="controls">Loading…</div>

  const file = state.files[state.currentFileIndex]
  const patch = (p: Partial<AppState>) => window.api.patchState(p)

  const askConfirm = (req: Omit<ConfirmRequest, 'resolve'>) =>
    new Promise<boolean>((resolve) => {
      setConfirmRequest({ ...req, resolve })
    })

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) await handleFiles(files)
  }

  const handleOpen = async () => {
    const result = await window.api.openFiles()
    if (result.errors.length) {
      showToast(result.errors.map((e) => `${e.path.split('/').pop()}: ${e.error}`).join(' • '))
    }
  }

  const handleSave = async () => {
    setSaveMsg('saving…')
    const result = await window.api.saveCurrent()
    setSaveMsg(result.ok ? 'saved ✓' : `error: ${result.error}`)
    setTimeout(() => setSaveMsg(null), 2000)
  }

  return (
    <div
      className={`controls ${dragOver ? 'controls--drop' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        if (!dragOver) setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false)
      }}
      onDrop={onDrop}
    >
      {dragOver && <div className="drop-overlay">Drop files to load</div>}
      {toast && (
        <div className="toast" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
      {confirmRequest && (
        <ConfirmModal
          request={confirmRequest}
          onResolve={(v) => {
            confirmRequest.resolve(v)
            setConfirmRequest(null)
          }}
        />
      )}

      <aside className="sidebar">
        <div className="sidebar__header">
          <div className="sidebar__title">Scripts</div>
          <button className="btn btn--primary" onClick={handleOpen}>
            + Open
          </button>
        </div>

        <div className="sidebar__list">
          {state.files.length === 0 && (
            <div style={{ color: 'var(--muted)', padding: 12, fontSize: 12 }}>
              No files loaded. Click <b>+ Open</b> or drag files here.
            </div>
          )}
          {state.files.map((f, i) => (
            <div
              key={f.path + i}
              className={`file ${i === state.currentFileIndex ? 'file--active' : ''}`}
              onClick={() => window.api.selectFile(i)}
              title={f.path}
            >
              <span className="file__name">{f.name}</span>
              <button
                className="file__remove"
                title="Remove"
                onClick={(e) => {
                  e.stopPropagation()
                  window.api.removeFile(i)
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        {state.recentFiles.length > 0 && (
          <div className="recent">
            <div className="recent__label">Recent</div>
            {state.recentFiles.slice(0, 6).map((p) => (
              <div
                key={p}
                className="recent__item"
                onClick={() => window.api.loadFromPath(p)}
                title={p}
              >
                {p.split('/').pop()}
              </div>
            ))}
          </div>
        )}

        <div className="examples">
          <div className="examples__label">Examples</div>
          {EXAMPLES.map((ex) => (
            <div
              key={ex.fileName}
              className="example"
              onClick={() => window.api.loadFromContent(ex.fileName, ex.content)}
              title={ex.description}
            >
              <span className="example__name">{ex.label}</span>
              <span className="example__desc">{ex.description}</span>
            </div>
          ))}
        </div>
      </aside>

      <main className="main">
        {platform?.displayServer === 'wayland' && (
          <div className="banner-warn">
            Running on Wayland — always-on-top, screen-capture hiding, and global hotkeys may be
            limited by the compositor. XWayland gives the most predictable behavior.
          </div>
        )}
        <div className="transport">
          <button
            className="btn btn--primary"
            onClick={() => window.api.togglePlay()}
            disabled={!file}
          >
            {state.playing ? '⏸  Pause' : '▶  Play'}
          </button>
          <button
            className="btn"
            onClick={() => patch({ scrollPosition: 0, playing: false })}
            disabled={!file}
          >
            ↺ Restart
          </button>
          <button className="btn" onClick={() => window.api.reloadCurrent()} disabled={!file}>
            ⟳ Reload
          </button>
          <input
            className="scrub"
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={state.scrollPosition}
            onChange={(e) => window.api.setScrollPosition(parseFloat(e.target.value))}
            style={{ flex: 1, marginLeft: 12 }}
            disabled={!file}
          />
          <div className="transport__pos">
            {(state.scrollPosition * 100).toFixed(0)}%
          </div>
        </div>

        {state.editMode && file && (
          <EditorPane
            file={file}
            index={state.currentFileIndex}
            saveMsg={saveMsg}
            onSave={handleSave}
            onClose={() => patch({ editMode: false })}
          />
        )}

        <div className="panels">
          <Panel title="Transparency & sizing">
            <Range
              label="Opacity"
              value={state.opacity}
              min={0.05}
              max={1}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => patch({ opacity: v })}
            />
            <Range
              label="BG dim"
              value={state.bgDim}
              min={0}
              max={1}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => patch({ bgDim: v })}
            />
            <Range
              label="Eye-line"
              value={state.eyeLinePosition}
              min={0.05}
              max={0.95}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => patch({ eyeLinePosition: v })}
            />
          </Panel>

          <PacingTargetPanel state={state} wordCount={tokens.length} geom={overlayGeom} patch={patch} />

          <Panel title="Typography">
            <Range
              label="Font size"
              value={state.fontSize}
              min={16}
              max={140}
              step={1}
              format={(v) => `${v.toFixed(0)}px`}
              onChange={(v) => patch({ fontSize: v })}
            />
            <div className="row">
              <label>Family</label>
              <select
                value={state.fontFamily}
                onChange={(e) => patch({ fontFamily: e.target.value })}
              >
                <option value="Inter, system-ui, sans-serif">Inter / System</option>
                <option value="Georgia, serif">Georgia</option>
                <option value="ui-monospace, monospace">Monospace</option>
                <option value="'Helvetica Neue', Arial, sans-serif">Helvetica</option>
                <option value="'Times New Roman', serif">Times</option>
                <option value="OpenDyslexic, sans-serif">OpenDyslexic</option>
              </select>
            </div>
            <div className="row">
              <label>Color</label>
              <input
                type="color"
                className="color-input"
                value={state.fontColor}
                onChange={(e) => patch({ fontColor: e.target.value })}
              />
              <input
                type="text"
                value={state.fontColor}
                onChange={(e) => patch({ fontColor: e.target.value })}
              />
            </div>
            <Toggle
              label="Drop shadow"
              checked={state.textShadow}
              onChange={(v) => patch({ textShadow: v })}
            />
            <Toggle
              label="Force markdown rendering"
              checked={state.markdown}
              onChange={(v) => patch({ markdown: v })}
              hint=".md and .markdown files always render as markdown; toggle this on to force it for other extensions too"
            />
          </Panel>

          <Panel title="Layout">
            <Toggle
              label="Banner / lower-third mode"
              checked={state.bannerMode}
              onChange={(v) => patch({ bannerMode: v })}
              hint="Single-line horizontal scroll. Resize the overlay window to a thin strip."
            />
            <div className="row">
              <label>Banner edge</label>
              <select
                value={state.bannerPosition}
                onChange={(e) => patch({ bannerPosition: e.target.value as BannerPosition })}
                disabled={!state.bannerMode}
              >
                <option value="top">Top</option>
                <option value="bottom">Bottom</option>
              </select>
            </div>
          </Panel>

          <Panel title="Overlay behavior">
            <Toggle
              label="Click-through"
              checked={state.clickThrough}
              onChange={(v) => patch({ clickThrough: v })}
              hint="Mouse passes through to apps below"
            />
            <Toggle
              label="Hide from screen capture"
              checked={state.hideFromCapture}
              onChange={(v) => patch({ hideFromCapture: v })}
              disabled={platform ? !platform.contentProtectionSupported : false}
              hint={
                platform && !platform.contentProtectionSupported
                  ? 'Not supported on Linux (Electron limitation)'
                  : 'Invisible in OBS / Zoom / recordings'
              }
            />
            <Toggle
              label="Stay above fullscreen apps"
              checked={state.aboveFullscreen}
              disabled={platform?.platform !== 'linux'}
              onChange={(v) => patch({ aboveFullscreen: v })}
              hint={
                platform?.platform === 'linux'
                  ? 'Marks the overlay as a notification-type window (recreates it). Some compositors restrict drag/click on this type — flip off if interaction breaks.'
                  : 'Linux-only; alwaysOnTop already covers this on macOS/Windows'
              }
            />
            <Toggle
              label="Show eye-line"
              checked={state.showEyeLine}
              onChange={(v) => patch({ showEyeLine: v })}
            />
            <Toggle
              label="Focus mode (mask other lines)"
              checked={state.focusMode}
              onChange={(v) => patch({ focusMode: v })}
            />
            <Toggle
              label="Mirror horizontal"
              checked={state.mirrorH}
              onChange={(v) => patch({ mirrorH: v })}
              hint="For beam-splitter rigs"
            />
            <Toggle
              label="Mirror vertical"
              checked={state.mirrorV}
              onChange={(v) => patch({ mirrorV: v })}
            />
          </Panel>

          <Panel title="Voice pacing">
            <Toggle
              label="Listen & auto-advance"
              checked={state.voicePacing}
              onChange={async (v) => {
                if (v && !state.voiceConsent) {
                  const ok = await askConfirm({
                    title: 'Enable voice pacing?',
                    body:
                      'Voice pacing uses the Web Speech API. On Chromium-based apps (including Electron), this typically streams microphone audio to a Google service for transcription. The status bar will display "voice (cloud)" while active.',
                    confirmLabel: 'Enable',
                    danger: true,
                  })
                  if (!ok) return
                  patch({ voiceConsent: true, voicePacing: true })
                  return
                }
                patch({ voicePacing: v })
              }}
              hint="Sends mic audio to Google for transcription (cloud STT)"
            />
            {voiceError && (
              <div style={{ color: 'var(--danger)', fontSize: 11, marginTop: 6 }}>{voiceError}</div>
            )}
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
              Tokens in script: <b>{tokens.length}</b>
            </div>
          </Panel>

          <Panel title="Editing">
            <Toggle
              label="Live edit pane"
              checked={state.editMode}
              onChange={(v) => patch({ editMode: v })}
              hint="Edit current file; changes push to overlay live"
            />
            <button
              className="btn"
              onClick={async () => {
                const blank = await window.api.loadFromContent(
                  `untitled-${Date.now()}.md`,
                  '# New script\n\n[[CUE: intro]] Start typing…',
                )
                const cur = stateRef.current
                if (cur) await window.api.selectFile(cur.files.length)
                await window.api.patchState({ editMode: true })
                void blank
              }}
              style={{ marginTop: 8 }}
            >
              + New blank script
            </button>
          </Panel>

          <Panel title="Cue points">
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
              Insert <code style={{ color: 'var(--text)' }}>[[CUE: name]]</code> in the script.
              First 9 are bound to <b>Ctrl+Alt+1..9</b>.
            </div>
            <Toggle
              label="Show cue HUD on overlay"
              checked={state.showCueHud}
              onChange={(v) => patch({ showCueHud: v })}
              hint="Bottom-left list of upcoming cues with current highlighted"
            />
            {cues.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>No cues in current file.</div>
            ) : (
              <div className="cues">
                {cues.map((c) => (
                  <button
                    key={c.index}
                    className="cue"
                    onClick={() => window.api.setScrollPosition(c.position)}
                    title={`Jump to ${(c.position * 100).toFixed(0)}%`}
                  >
                    <span className="cue__num">
                      {c.index < 9 ? `⌃⌥${c.index + 1}` : `#${c.index + 1}`}
                    </span>
                    <span className="cue__name">{c.name}</span>
                    <span className="cue__pct">{(c.position * 100).toFixed(0)}%</span>
                  </button>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Countdown">
            <Toggle
              label="3-2-1 before play"
              checked={state.countdownEnabled}
              onChange={(v) => patch({ countdownEnabled: v })}
              hint="Only triggers when starting from the top"
            />
            <Range
              label="Seconds"
              value={state.countdownSeconds}
              min={1}
              max={10}
              step={1}
              format={(v) => `${v}s`}
              onChange={(v) => patch({ countdownSeconds: Math.round(v) })}
            />
          </Panel>

          <Panel title="Remote / clicker">
            <Toggle
              label="Listen for clicker (PageUp/PageDown)"
              checked={state.clickerMode}
              onChange={(v) => patch({ clickerMode: v })}
              hint="Most presentation clickers send these. Steals the keys globally while on."
            />
            <Range
              label="Step size"
              value={state.clickerStep}
              min={0.01}
              max={0.5}
              step={0.01}
              format={(v) => `${(v * 100).toFixed(0)}%`}
              onChange={(v) => patch({ clickerStep: v })}
            />
            <Toggle
              label="Show chronometer in overlay"
              checked={state.showChronometer}
              onChange={(v) => patch({ showChronometer: v })}
              hint="Elapsed · time-to-end · target WPM"
            />
            <Toggle
              label="Drive presentation (Right/Left to focused window)"
              checked={state.drivePresentation}
              disabled={!presentationStatus?.ok}
              onChange={(v) => patch({ drivePresentation: v })}
              hint={
                presentationStatus?.ok
                  ? 'Each clicker step also sends Right/Left arrow to whichever window has focus'
                  : presentationStatus?.reason ?? 'Capability unknown'
              }
            />
          </Panel>

          <SettingsPanel onToast={showToast} onConfirm={askConfirm} />

          <HotkeysPanel
            bindings={state.hotkeyBindings}
            failed={failedHotkeys}
            onChange={(b) => patch({ hotkeyBindings: b })}
            onReload={() => window.api.getHotkeyStatus().then((s) => setFailedHotkeys(s.failed))}
          />
        </div>

        <div className="status">
          <span className={`status__pill ${state.playing ? 'status__pill--on' : ''}`}>
            {state.playing ? 'PLAYING' : 'PAUSED'}
          </span>
          <span className={`status__pill ${state.bannerMode ? 'status__pill--on' : ''}`}>
            {state.bannerMode ? `banner-${state.bannerPosition}` : 'full'}
          </span>
          <span className={`status__pill ${state.clickThrough ? 'status__pill--on' : ''}`}>
            click-through {state.clickThrough ? 'on' : 'off'}
          </span>
          <span className={`status__pill ${state.hideFromCapture ? 'status__pill--on' : ''}`}>
            capture-hide {state.hideFromCapture ? 'on' : 'off'}
          </span>
          <span className={`status__pill ${state.voicePacing ? 'status__pill--on' : ''}`}>
            {state.voicePacing ? 'voice (cloud)' : 'voice off'}
          </span>
          <span
            className={`status__pill ${
              state.markdown || (file && /\.(md|markdown)$/i.test(file.path)) ? 'status__pill--on' : ''
            }`}
          >
            md{' '}
            {state.markdown
              ? 'forced'
              : file && /\.(md|markdown)$/i.test(file.path)
                ? 'auto'
                : 'off'}
          </span>
          <span style={{ marginLeft: 'auto' }}>
            {file ? file.name : '— no file —'}
          </span>
        </div>
      </main>
    </div>
  )
}

function Panel(props: { title: string; children: React.ReactNode; defaultCollapsed?: boolean }) {
  const key = `panel-collapsed:${props.title}`
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const stored = localStorage.getItem(key)
      if (stored === '1') return true
      if (stored === '0') return false
    } catch {
      /* ignore */
    }
    return props.defaultCollapsed ?? false
  })
  const toggle = () => {
    setCollapsed((c) => {
      const next = !c
      try {
        localStorage.setItem(key, next ? '1' : '0')
      } catch {
        /* ignore */
      }
      return next
    })
  }
  return (
    <section className={`panel ${collapsed ? 'panel--collapsed' : ''}`}>
      <h3 className="panel__title" onClick={toggle} role="button" aria-expanded={!collapsed}>
        <span className="panel__chevron">{collapsed ? '▸' : '▾'}</span>
        {props.title}
      </h3>
      {!collapsed && <div className="panel__body">{props.children}</div>}
    </section>
  )
}

function Range(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format?: (v: number) => string
  onChange: (v: number) => void
}) {
  return (
    <div className="row">
      <label>{props.label}</label>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(parseFloat(e.target.value))}
      />
      <div className="row__value">{props.format ? props.format(props.value) : props.value}</div>
    </div>
  )
}

function parseDuration(s: string): number | null {
  const t = s.trim()
  if (!t) return null
  const hms = t.match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/)
  if (hms) {
    const h = parseInt(hms[1], 10)
    const m = parseInt(hms[2], 10)
    const sec = parseFloat(hms[3])
    if (m >= 60 || sec >= 60) return null
    return h * 3600 + m * 60 + sec
  }
  const ms = t.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/)
  if (ms) {
    const m = parseInt(ms[1], 10)
    const sec = parseFloat(ms[2])
    if (sec >= 60) return null
    return m * 60 + sec
  }
  const n = parseFloat(t)
  if (Number.isFinite(n) && n > 0) return n * 60
  return null
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m}:${s.toString().padStart(2, '0')}`
}

function PacingTargetPanel({
  state,
  wordCount,
  geom,
  patch,
}: {
  state: AppState
  wordCount: number
  geom: { textH: number; viewportH: number }
  patch: (p: Partial<AppState>) => void
}) {
  const range = Math.max(0, geom.textH - geom.viewportH)
  const ready = range > 0 && wordCount > 0
  const scrollSpeed = state.scrollSpeed

  const totalSec = ready ? range / Math.max(1, scrollSpeed) : 0
  const currentWpm = totalSec > 0 ? (wordCount * 60) / totalSec : 0

  const displayDurSec =
    state.targetMode === 'duration' && state.targetDurationSec ? state.targetDurationSec : totalSec
  const displayWpm =
    state.targetMode === 'wpm' && state.targetWpm ? state.targetWpm : currentWpm

  const [durStr, setDurStr] = useState('')
  const [wpmStr, setWpmStr] = useState('')
  const [parseError, setParseError] = useState<string | null>(null)

  useEffect(() => {
    setDurStr(displayDurSec > 0 ? formatDuration(displayDurSec) : '')
    setWpmStr(displayWpm > 0 ? Math.round(displayWpm).toString() : '')
    setParseError(null)
  }, [displayDurSec, displayWpm])

  const commitDuration = () => {
    if (!durStr.trim()) {
      setParseError(null)
      return
    }
    const secs = parseDuration(durStr)
    if (secs === null) {
      setParseError('Use mm:ss, h:mm:ss, or minutes (e.g. 5:30, 1:05:00, 4.5)')
      return
    }
    setParseError(null)
    patch({ targetMode: 'duration', targetDurationSec: secs })
  }

  const commitWpm = () => {
    if (!wpmStr.trim()) return
    const n = parseFloat(wpmStr)
    if (!Number.isFinite(n) || n <= 0) return
    setParseError(null)
    patch({ targetMode: 'wpm', targetWpm: n })
  }

  const clearTarget = () => {
    patch({ targetMode: null, targetDurationSec: null, targetWpm: null })
  }

  return (
    <Panel title="Pacing target">
      {!ready && (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
          Load a file and let the overlay render to enable.
        </div>
      )}
      <div className="row">
        <label>Duration</label>
        <input
          type="text"
          inputMode="text"
          placeholder="mm:ss or h:mm:ss"
          value={durStr}
          onChange={(e) => setDurStr(e.target.value)}
          onBlur={commitDuration}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
        />
      </div>
      <div className="row">
        <label>Target WPM</label>
        <input
          type="number"
          step="1"
          min="20"
          max="2000"
          value={wpmStr}
          onChange={(e) => setWpmStr(e.target.value)}
          onBlur={commitWpm}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
        />
        <span className="row__value">wpm</span>
      </div>
      {parseError && (
        <div style={{ fontSize: 10, color: 'var(--danger)', marginTop: 4 }}>{parseError}</div>
      )}
      <div
        style={{
          fontSize: 10,
          color: 'var(--muted)',
          lineHeight: 1.6,
          marginTop: 6,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span style={{ flex: 1 }}>
          {ready ? (
            <>
              Words: <b>{wordCount.toLocaleString()}</b> · range:{' '}
              <b>{range.toLocaleString()} px</b> · speed:{' '}
              <b>{scrollSpeed.toFixed(1)} px/s</b>
            </>
          ) : (
            'Type a duration, press Enter or click away to apply.'
          )}
        </span>
        {state.targetMode && (
          <button
            className="btn btn--ghost"
            onClick={clearTarget}
            title="Clear pacing target — speed becomes manually editable again"
            style={{ fontSize: 10, padding: '2px 6px' }}
          >
            target: {state.targetMode} ✕
          </button>
        )}
      </div>
    </Panel>
  )
}

function keyEventToAccelerator(e: React.KeyboardEvent): string | null {
  const k = e.key
  if (k === 'Control' || k === 'Alt' || k === 'Shift' || k === 'Meta') return null
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  let key = ''
  const map: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ' ': 'Space',
    Enter: 'Return',
    Escape: 'Escape',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Home: 'Home',
    End: 'End',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Tab: 'Tab',
  }
  if (k.length === 1) {
    key = k.toUpperCase()
  } else if (map[k]) {
    key = map[k]
  } else if (/^F\d{1,2}$/.test(k)) {
    key = k
  } else {
    return null
  }
  parts.push(key)
  return parts.join('+')
}

function prettifyAccelerator(accel: string): string {
  if (!accel) return '(none)'
  return accel
    .replace(/CommandOrControl/g, 'Ctrl')
    .replace(/\+Up\b/g, '+↑')
    .replace(/\+Down\b/g, '+↓')
    .replace(/\+Left\b/g, '+←')
    .replace(/\+Right\b/g, '+→')
}

function HotkeysPanel({
  bindings,
  failed,
  onChange,
  onReload,
}: {
  bindings: Record<HotkeyCommand, string>
  failed: string[]
  onChange: (b: Record<HotkeyCommand, string>) => void
  onReload: () => void
}) {
  const [editing, setEditing] = useState<HotkeyCommand | null>(null)
  const [hint, setHint] = useState<string | null>(null)

  useEffect(() => {
    onReload()
  }, [bindings, onReload])

  const startEdit = (cmd: HotkeyCommand) => {
    setEditing(cmd)
    setHint('Press the new shortcut, or Esc to cancel')
  }

  const onCaptureKeyDown = (cmd: HotkeyCommand, e: React.KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      setEditing(null)
      setHint(null)
      return
    }
    const accel = keyEventToAccelerator(e)
    if (!accel) return
    const next = { ...bindings, [cmd]: accel }
    if (Object.values(next).filter((a, i) => Object.values(next).indexOf(a) !== i).length) {
      setHint(`${prettifyAccelerator(accel)} is already used by another command`)
      return
    }
    onChange(next)
    setEditing(null)
    setHint(null)
  }

  const reset = (cmd: HotkeyCommand) => {
    onChange({ ...bindings, [cmd]: DEFAULT_HOTKEYS[cmd] })
  }

  const resetAll = () => {
    onChange({ ...DEFAULT_HOTKEYS })
  }

  return (
    <Panel title="Hotkeys">
      {failed.length > 0 && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--danger)',
            background: 'rgba(255,99,99,0.1)',
            padding: '6px 8px',
            borderRadius: 4,
            marginBottom: 8,
            border: '1px solid rgba(255,99,99,0.3)',
          }}
        >
          <b>{failed.length}</b> shortcut{failed.length === 1 ? '' : 's'} failed to register
          (likely held by another app or compositor):
          <div style={{ fontFamily: 'ui-monospace, monospace', marginTop: 4 }}>
            {failed.map(prettifyAccelerator).join(', ')}
          </div>
        </div>
      )}

      <div className="hotkey-rows">
        {(Object.keys(DEFAULT_HOTKEYS) as HotkeyCommand[]).map((cmd) => {
          const accel = bindings[cmd] ?? DEFAULT_HOTKEYS[cmd]
          const isEditing = editing === cmd
          const isFailed = failed.includes(accel)
          return (
            <div key={cmd} className="hotkey-row">
              <span className="hotkey-row__label">{HOTKEY_LABELS[cmd]}</span>
              {isEditing ? (
                <input
                  className="hotkey-row__capture"
                  autoFocus
                  readOnly
                  value="press keys…"
                  onKeyDown={(e) => onCaptureKeyDown(cmd, e)}
                  onBlur={() => setEditing(null)}
                />
              ) : (
                <button
                  className={`hotkey-row__accel ${isFailed ? 'hotkey-row__accel--failed' : ''}`}
                  onClick={() => startEdit(cmd)}
                  title="Click to rebind"
                >
                  {prettifyAccelerator(accel)}
                </button>
              )}
              {accel !== DEFAULT_HOTKEYS[cmd] && (
                <button
                  className="hotkey-row__reset"
                  onClick={() => reset(cmd)}
                  title="Reset to default"
                >
                  ↺
                </button>
              )}
            </div>
          )
        })}
      </div>

      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>{hint}</div>}

      <div
        style={{ marginTop: 12, fontSize: 10, color: 'var(--muted)', lineHeight: 1.6 }}
      >
        <div>
          <b>Ctrl+Alt+1..9</b> — Jump to cue 1–9 (fixed)
        </div>
        <div>
          <b>PageUp / PageDown</b> — Step back / forward (clicker mode, fixed)
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
        <button className="btn btn--ghost" onClick={resetAll}>
          Reset all
        </button>
      </div>
    </Panel>
  )
}

type ConfirmRequest = {
  title: string
  body: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  resolve: (v: boolean) => void
}

function ConfirmModal({ request, onResolve }: { request: ConfirmRequest; onResolve: (v: boolean) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onResolve(false)
      if (e.key === 'Enter') onResolve(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onResolve])

  return (
    <div className="modal-backdrop" onClick={() => onResolve(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__title">{request.title}</div>
        <div className="modal__body">{request.body}</div>
        <div className="modal__actions">
          <button className="btn" onClick={() => onResolve(false)}>
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            className={request.danger ? 'btn btn--danger' : 'btn btn--primary'}
            onClick={() => onResolve(true)}
            autoFocus
          >
            {request.confirmLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}

function SettingsPanel({
  onToast,
  onConfirm,
}: {
  onToast: (msg: string) => void
  onConfirm: (req: Omit<ConfirmRequest, 'resolve'>) => Promise<boolean>
}) {
  const [about, setAbout] = useState<{
    appVersion: string
    electronVersion: string
    nodeVersion: string
    storePath: string
  } | null>(null)

  useEffect(() => {
    window.api.getAbout().then(setAbout)
  }, [])

  const handleReset = async () => {
    const ok = await onConfirm({
      title: 'Reset all settings?',
      body:
        'This restores all sliders, toggles, and preferences to defaults and clears the playlist + recent files. Loaded file paths and any unsaved edits will be lost.',
      confirmLabel: 'Reset',
      danger: true,
    })
    if (!ok) return
    await window.api.resetSettings()
    onToast('Settings reset to defaults')
  }

  const handleExport = async () => {
    const r = await window.api.exportSettings()
    if (r.ok) onToast(`Exported to ${r.path}`)
    else if (r.error !== 'cancelled') onToast(`Export failed: ${r.error}`)
  }

  const handleImport = async () => {
    const r = await window.api.importSettings()
    if (r.ok) onToast('Settings imported')
    else if (r.error !== 'cancelled') onToast(`Import failed: ${r.error}`)
  }

  return (
    <Panel title="Settings">
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        <button className="btn" onClick={handleExport}>
          Export
        </button>
        <button className="btn" onClick={handleImport}>
          Import
        </button>
        <button className="btn" onClick={handleReset} style={{ marginLeft: 'auto' }}>
          Reset to defaults
        </button>
      </div>
      {about && (
        <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
          <div>
            Version <b style={{ color: 'var(--text)' }}>{about.appVersion}</b>
          </div>
          <div>
            Electron <b style={{ color: 'var(--text)' }}>{about.electronVersion}</b> · Node{' '}
            <b style={{ color: 'var(--text)' }}>{about.nodeVersion}</b>
          </div>
          <div
            style={{
              fontFamily: 'ui-monospace, monospace',
              fontSize: 10,
              wordBreak: 'break-all',
              marginTop: 4,
            }}
            title={about.storePath}
          >
            {about.storePath}
          </div>
        </div>
      )}
    </Panel>
  )
}

function EditorPane({
  file,
  index,
  saveMsg,
  onSave,
  onClose,
}: {
  file: ScriptFile
  index: number
  saveMsg: string | null
  onSave: () => void
  onClose: () => void
}) {
  const [local, setLocal] = useState(file.content)
  const lastPathRef = useRef(file.path)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (lastPathRef.current !== file.path) {
      setLocal(file.content)
      lastPathRef.current = file.path
    }
  }, [file.path, file.content])

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    },
    [],
  )

  const handleChange = (v: string) => {
    setLocal(v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null
      window.api.updateContent(index, v)
    }, 200)
  }

  const flush = () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
      window.api.updateContent(index, local)
    }
  }

  return (
    <div className="editor">
      <div className="editor__header">
        <span>
          editing <b>{file.name}</b>
          {file.path.startsWith('mem://') && (
            <span style={{ color: 'var(--muted)' }}> (unsaved)</span>
          )}
        </span>
        <div style={{ flex: 1 }} />
        {saveMsg && <span className="editor__msg">{saveMsg}</span>}
        <button
          className="btn"
          onClick={() => {
            flush()
            onSave()
          }}
        >
          💾 Save
        </button>
        <button
          className="btn btn--ghost"
          onClick={() => {
            flush()
            onClose()
          }}
        >
          Close
        </button>
      </div>
      <textarea
        className="editor__area"
        value={local}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={flush}
        spellCheck={false}
        placeholder="Type your script…"
      />
    </div>
  )
}

function Toggle(props: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  hint?: string
  disabled?: boolean
}) {
  return (
    <div
      className="row"
      style={{ alignItems: 'flex-start', opacity: props.disabled ? 0.5 : 1 }}
    >
      <label className="toggle" style={{ flex: 1, cursor: props.disabled ? 'not-allowed' : 'pointer' }}>
        <input
          type="checkbox"
          checked={props.checked}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.checked)}
        />
        <span>
          {props.label}
          {props.hint && (
            <div style={{ color: 'var(--muted)', fontSize: 10, marginTop: 2 }}>{props.hint}</div>
          )}
        </span>
      </label>
    </div>
  )
}
