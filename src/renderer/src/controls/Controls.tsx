import { useEffect, useMemo, useRef, useState } from 'react'
import { parseCues, stripCues } from '../../../shared/cues'
import type { AppSnapshot, DocumentContent, DocumentMeta } from '../../../shared/contracts'
import type { PlatformInfo, PreferencePatch, PresentationStatus } from '../../../shared/ipc'
import { countWords } from '../../../shared/text'
import type { BannerPosition, HotkeyCommand } from '../../../shared/types'
import { HotkeysPanel } from './HotkeysPanel'
import { SettingsPanel } from './SettingsPanel'
import { ConfirmDialog, Panel, Range, Toggle, type ConfirmRequest } from './ui'

const DISPLAY_FAMILIES = [
  ['Inter, system-ui, sans-serif', 'Inter / System'],
  ['Georgia, serif', 'Georgia'],
  ['ui-monospace, monospace', 'Monospace'],
  ["'Helvetica Neue', Arial, sans-serif", 'Helvetica'],
  ["'Times New Roman', serif", 'Times'],
  ['OpenDyslexic, sans-serif', 'OpenDyslexic'],
] as const

export function Controls() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [documentContent, setDocumentContent] = useState<DocumentContent | null>(null)
  const [closing, setClosing] = useState(false)
  const [unresolvedDocuments, setUnresolvedDocuments] = useState<Array<Omit<DocumentMeta, 'saveMode'>>>([])
  const [startupIssues, setStartupIssues] = useState<string[]>([])
  const [storageStatus, setStorageStatus] = useState<{ lastPersistedAt: number | null; restoring: boolean }>({
    lastPersistedAt: null, restoring: false,
  })
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [platform, setPlatform] = useState<PlatformInfo | null>(null)
  const [presentation, setPresentation] = useState<PresentationStatus | null>(null)
  const [failedHotkeys, setFailedHotkeys] = useState<string[]>([])
  const [overlayGeometry, setOverlayGeometry] = useState({ textH: 0, viewportH: 0 })
  const [dragOver, setDragOver] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)
  const confirmationBusy = useRef(false)
  const confirmationRef = useRef<ConfirmRequest | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const derivedContent = useMemo(() => {
    const source = documentContent?.content ?? ''
    const visible = stripCues(source)
    return {
      visible,
      wordCount: countWords(visible),
      cues: parseCues(source),
    }
  }, [documentContent?.id, documentContent?.revision, documentContent?.content])

  const showToast = (message: string, timeoutMs = 5000) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast(message)
    toastTimer.current = setTimeout(() => setToast(null), timeoutMs)
  }

  const perform = async (operation: () => Promise<unknown>): Promise<void> => {
    try { await operation() }
    catch (error) { showToast(error instanceof Error ? error.message : 'The operation could not be completed') }
  }

  useEffect(() => {
    const unsubscribeClosing = window.controlsApi.onClosingChanged((value) => {
      setClosing(value)
      if (value) {
        confirmationRef.current?.resolve(false)
        setConfirmRequest(null)
      }
    })
    const unsubscribeUnresolved = window.controlsApi.onUnresolvedDocuments(setUnresolvedDocuments)
    const unsubscribeSnapshot = window.controlsApi.onSnapshot(setSnapshot)
    const unsubscribeDocument = window.controlsApi.onActiveDocument(setDocumentContent)
    const unsubscribeProgress = window.controlsApi.onProgress((position) => {
      setSnapshot((current) => (current ? { ...current, scrollPosition: position } : current))
    })
    const unsubscribeStorage = window.controlsApi.onStorageIssues(setStartupIssues)
    const unsubscribeStorageStatus = window.controlsApi.onStorageStatus(setStorageStatus)
    const unsubscribeGeometry = window.controlsApi.onOverlayGeometry(setOverlayGeometry)

    void window.controlsApi
      .bootstrap()
      .then((payload) => {
        setSnapshot(payload.snapshot)
        setDocumentContent(payload.activeDocument)
        setStartupIssues(payload.startupIssues)
        setStorageStatus(payload.storageStatus)
        setUnresolvedDocuments(payload.unresolvedDocuments)
      })
      .catch((error: unknown) => {
        setFatalError(error instanceof Error ? error.message : 'Controls failed to initialize')
      })
    void window.controlsApi.getPlatformInfo().then(setPlatform).catch(() => undefined)
    void window.controlsApi.getPresentationStatus().then(setPresentation).catch(() => undefined)
    void window.controlsApi.getHotkeyStatus().then((status) => setFailedHotkeys(status.failed)).catch(() => undefined)

    return () => {
      unsubscribeClosing()
      unsubscribeUnresolved()
      confirmationRef.current?.resolve(false)
      unsubscribeSnapshot()
      unsubscribeDocument()
      unsubscribeProgress()
      unsubscribeGeometry()
      unsubscribeStorage()
      unsubscribeStorageStatus()
      if (toastTimer.current) clearTimeout(toastTimer.current)
    }
  }, [])

  useEffect(() => {
    setOverlayGeometry({ textH: 0, viewportH: 0 })
  }, [documentContent?.id, documentContent?.revision, snapshot?.bannerMode])

  useEffect(() => {
    const onUnhandled = (event: PromiseRejectionEvent) => {
      event.preventDefault()
      showToast(event.reason instanceof Error ? event.reason.message : 'The action could not be completed')
    }
    window.addEventListener('unhandledrejection', onUnhandled)
    const preventDefault = (event: DragEvent) => event.preventDefault()
    document.addEventListener('dragover', preventDefault)
    return () => { document.removeEventListener('dragover', preventDefault); window.removeEventListener('unhandledrejection', onUnhandled) }
  }, [])

  if (fatalError) {
    return (
      <main className="fatal-screen">
        <h1>Teleprompt could not start</h1>
        <p>{fatalError}</p>
        <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
          Retry
        </button>
      </main>
    )
  }
  if (!snapshot) return <div className="controls controls--loading" role="status">Loading workspace…</div>

  const metadata = snapshot.documents.find((item) => item.id === snapshot.activeDocumentId) ?? null
  const activeContent = documentContent?.id === metadata?.id ? documentContent : null
  const wordCount = activeContent ? derivedContent.wordCount : 0
  const cues = activeContent ? derivedContent.cues : []

  const patch = (value: PreferencePatch) => {
    void window.controlsApi.updatePreferences(value).catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : 'Unable to update preferences')
    })
  }

  const askConfirm = (request: Omit<ConfirmRequest, 'resolve'>) => {
    if (confirmationBusy.current) return Promise.resolve(false)
    confirmationBusy.current = true
    return new Promise<boolean>((resolve) => {
      const next = { ...request, resolve: (value: boolean) => {
        confirmationBusy.current = false
        confirmationRef.current = null
        resolve(value)
      } }
      confirmationRef.current = next
      setConfirmRequest(next)
    })
  }

  const selectDocument = (id: string) => perform(() => window.controlsApi.selectDocument(id))

  const removeDocument = (item: DocumentMeta) => perform(async () => {
    const result = await window.controlsApi.removeDocument(item.id)
    if (!result.ok) showToast(`Could not remove ${item.name}: ${result.reason}`)
  })

  const openFiles = () => perform(async () => {
    const result = await window.controlsApi.openFiles()
    if (result.errors.length) showToast(result.errors.map((item) => `${item.name}: ${item.error}`).join(' • '), 8000)
  })

  const openDropped = (files: File[]) => perform(async () => {
    const errors: string[] = []
    for (const file of files) {
      const result = await window.controlsApi.openDroppedFile(file)
      if (!result.ok) errors.push(`${file.name}: ${result.error}`)
    }
    if (errors.length) showToast(errors.join(' • '), 8000)
  })

  const reloadDocument = () => perform(async () => {
    if (!metadata?.sourcePath) return
    const result = await window.controlsApi.reloadDocument(metadata.id)
    if (!result.ok) showToast(`Reload failed: ${result.reason}`)
  })

  return (
    <>
    {closing && <div className="banner-warn" role="status">Saving preferences and closing the workspace…</div>}
    <div
      {...(closing ? { inert: '' } : {})}
      aria-busy={closing}
      className={`controls ${dragOver ? 'controls--drop' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(event) => event.currentTarget === event.target && setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragOver(false)
        void openDropped(Array.from(event.dataTransfer.files))
      }}
    >
      {dragOver && <div className="drop-overlay">Drop scripts to import</div>}
      {toast && (
        <button type="button" className="toast" role="alert" onClick={() => setToast(null)}>
          {toast}
        </button>
      )}
      {confirmRequest && (
        <ConfirmDialog
          request={confirmRequest}
          onResolve={(value) => {
            confirmRequest.resolve(value)
            setConfirmRequest(null)
          }}
        />
      )}

      <aside className="sidebar" aria-label="Script library">
        <div className="sidebar__header">
          <h1 className="sidebar__title">Teleprompt</h1>
          <button type="button" className="btn btn--primary" onClick={() => void openFiles()}>
            Open…
          </button>
        </div>
        <div className="sidebar__list">
          {snapshot.documents.length === 0 && (
            <p className="empty-state">Open a document or drop one here to start reading.</p>
          )}
          {snapshot.documents.map((item) => (
            <div key={item.id} className={`file ${item.id === metadata?.id ? 'file--active' : ''}`}>
              <button
                type="button"
                className="file__select"
                aria-current={item.id === metadata?.id ? 'true' : undefined}
                onClick={() => void selectDocument(item.id)}
                title={item.sourcePath ?? item.name}
              >
                <span className="file__name">{item.name}</span>
                {item.dirty && <span className="file__dirty" title="Recovered script">●</span>}
              </button>
              <button
                type="button"
                className="file__remove"
                aria-label={`Remove ${item.name}`}
                onClick={() => void removeDocument(item)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        {unresolvedDocuments.length > 0 && (
          <section aria-label="Unavailable scripts">
            <h2 className="sidebar__section-title">Unavailable scripts</h2>
            {unresolvedDocuments.map((item) => (
              <div key={item.id} className="file">
                <span className="file__name" title={item.sourcePath ?? item.name}>{item.name}</span>
                <button type="button" className="btn" onClick={() => perform(async () => {
                  const result = await window.controlsApi.reloadDocument(item.id)
                  if (!result.ok) showToast(`Retry failed: ${result.reason}`)
                })}>Retry</button>
                <button type="button" className="btn" onClick={() => perform(async () => {
                  const result = await window.controlsApi.removeDocument(item.id)
                  if (!result.ok) showToast(`Remove failed: ${result.reason}`)
                })}>Remove</button>
              </div>
            ))}
          </section>
        )}
        {snapshot.recentFiles.length > 0 && (
          <section className="recent" aria-labelledby="recent-heading">
            <h2 id="recent-heading" className="sidebar__section-title">Recent</h2>
            {snapshot.recentFiles.slice(0, 6).map((path) => (
              <button
                type="button"
                key={path}
                className="recent__item"
                title={path}
                onClick={() => perform(async () => {
                  const result = await window.controlsApi.openRecent(path)
                  if (!result.ok) showToast(`${fileName(path)}: ${result.error}`)
                })}
              >
                {fileName(path)}
              </button>
            ))}
          </section>
        )}

      </aside>

      <main className="main">
        {startupIssues.length > 0 && (
          <div className="banner-warn" role="status">
            <strong>Recovery notice:</strong> {startupIssues.join(' • ')}
            <button type="button" className="banner-warn__close" aria-label="Dismiss recovery notice" onClick={() => setStartupIssues([])}>×</button>
          </div>
        )}
        {platform?.displayServer === 'wayland' && (
          <div className="banner-warn">
            Wayland may limit global shortcuts, screen-capture protection, and always-on-top behavior. XWayland is the supported presentation path for this release.
          </div>
        )}
        <div className="transport" aria-label="Playback transport">
          <button
            type="button"
            className="btn btn--primary"
            disabled={!activeContent}
            onClick={() => perform(async () => {
              const result = await window.controlsApi.togglePlayback()
              if (!result.ok) showToast(result.reason ?? 'Unable to start playback')
            })}
          >
            {snapshot.playing ? 'Pause' : 'Play'}
          </button>
          <button type="button" className="btn" disabled={!activeContent} onClick={() => void perform(() => window.controlsApi.restartPlayback())}>
            Restart
          </button>
          <button type="button" className="btn" disabled={!metadata?.sourcePath} onClick={() => void reloadDocument()}>
            Reload source
          </button>
          <label className="sr-only" htmlFor="playback-position">Playback position</label>
          <input
            id="playback-position"
            className="scrub"
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={snapshot.scrollPosition}
            disabled={!activeContent}
            onChange={(event) => void perform(() => window.controlsApi.seek(Number(event.target.value)))}
          />
          <output className="transport__pos" htmlFor="playback-position">
            {(snapshot.scrollPosition * 100).toFixed(0)}%
          </output>
        </div>

        {activeContent && (
          <section className="script-preview" aria-label="Script preview">
            <h2>{metadata?.name}</h2>
            {metadata?.dirty && <p className="form-hint">Recovered script · read only</p>}
            <pre tabIndex={0} aria-label="Read-only script text" dir="auto">{derivedContent.visible.slice(0, 32_768)}</pre>
            {derivedContent.visible.length > 32_768 && (
              <p className="form-hint">Preview shows the first 32,768 characters. The overlay plays the full script.</p>
            )}
          </section>
        )}

        <div className="panels">
          <PacingPanel
            snapshot={snapshot}
            wordCount={wordCount}
            geometry={overlayGeometry}
            patch={patch}
          />

          <Panel title="Display">
            <Toggle
              label="Show overlay"
              checked={snapshot.overlayVisible}
              onChange={(visible) => window.controlsApi.setOverlayVisible(visible)}
            />
            <Range label="Opacity" value={snapshot.opacity} min={0.05} max={1} step={0.01} format={percent} onChange={(opacity) => patch({ opacity })} />
            <Range label="Background" value={snapshot.bgDim} min={0} max={1} step={0.01} format={percent} onChange={(bgDim) => patch({ bgDim })} />
            <Range label="Eye-line" value={snapshot.eyeLinePosition} min={0.05} max={0.95} step={0.01} format={percent} onChange={(eyeLinePosition) => patch({ eyeLinePosition })} />
          </Panel>

          <Panel title="Typography">
            <Range label="Font size" value={snapshot.fontSize} min={16} max={140} step={1} format={(value) => `${value}px`} onChange={(fontSize) => patch({ fontSize })} />
            <div className="row">
              <label htmlFor="font-family">Family</label>
              <select id="font-family" value={snapshot.fontFamily} onChange={(event) => patch({ fontFamily: event.target.value })}>
                {DISPLAY_FAMILIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
            <div className="row">
              <label htmlFor="font-color">Color</label>
              <input id="font-color" type="color" className="color-input" value={snapshot.fontColor} onChange={(event) => patch({ fontColor: event.target.value })} />
              <code className="color-value">{snapshot.fontColor}</code>
            </div>
            <Toggle label="Drop shadow" checked={snapshot.textShadow} onChange={(textShadow) => patch({ textShadow })} />
            <Toggle label="Force Markdown" checked={snapshot.markdown} onChange={(markdown) => patch({ markdown })} hint="Markdown files render automatically; enable this for other document types." />
          </Panel>

          <Panel title="Layout">
            <Toggle label="Banner / lower-third" checked={snapshot.bannerMode} onChange={(bannerMode) => patch({ bannerMode })} />
            <div className="row">
              <label htmlFor="banner-edge">Banner edge</label>
              <select id="banner-edge" disabled={!snapshot.bannerMode} value={snapshot.bannerPosition} onChange={(event) => patch({ bannerPosition: event.target.value as BannerPosition })}>
                <option value="top">Top</option><option value="bottom">Bottom</option>
              </select>
            </div>
            <Toggle label="Show eye-line" checked={snapshot.showEyeLine} onChange={(showEyeLine) => patch({ showEyeLine })} />
            <Toggle label="Focus mask" checked={snapshot.focusMode} onChange={(focusMode) => patch({ focusMode })} />
            <Toggle label="Mirror horizontally" checked={snapshot.mirrorH} onChange={(mirrorH) => patch({ mirrorH })} hint="For beam-splitter rigs." />
            <Toggle label="Mirror vertically" checked={snapshot.mirrorV} onChange={(mirrorV) => patch({ mirrorV })} />
          </Panel>

          <Panel title="Overlay behavior">
            <Toggle label="Click-through" checked={snapshot.clickThrough} onChange={(clickThrough) => patch({ clickThrough })} hint="Mouse input passes to the application below." />
            <Toggle
              label="Hide from screen capture"
              checked={snapshot.hideFromCapture}
              disabled={platform ? !platform.contentProtectionSupported : false}
              onChange={(hideFromCapture) => patch({ hideFromCapture })}
              hint={platform && !platform.contentProtectionSupported ? 'Electron does not support this on Linux.' : 'Requests capture protection from the operating system.'}
            />
            <Toggle
              label="Stay above fullscreen apps"
              checked={snapshot.aboveFullscreen}
              disabled={platform?.platform !== 'linux'}
              onChange={(aboveFullscreen) => patch({ aboveFullscreen })}
              hint="Linux notification-window mode; compositor support varies."
            />
          </Panel>

          <Panel title="Cue points">
            <Toggle label="Show cue HUD" checked={snapshot.showCueHud} onChange={(showCueHud) => patch({ showCueHud })} />
            <p className="form-hint">Add <code>[[CUE: name]]</code> in your source file, then reload it. Ctrl+Alt+1–9 jumps to the first nine cues.</p>
            <div className="cues">
              {cues.length === 0 && <span className="form-hint">No cues in this script.</span>}
              {cues.map((cue) => (
                <button type="button" key={cue.index} className="cue" onClick={() => void perform(() => window.controlsApi.seek(cue.position))}>
                  <span className="cue__num">{cue.index < 9 ? `⌃⌥${cue.index + 1}` : `#${cue.index + 1}`}</span>
                  <span className="cue__name">{cue.name}</span>
                  <span className="cue__pct">{(cue.position * 100).toFixed(0)}%</span>
                </button>
              ))}
            </div>
          </Panel>

          <Panel title="Remote & presentation">
            <Toggle label="Arm Page Up/Down clicker" checked={snapshot.clickerMode} onChange={(enabled) => window.controlsApi.setClickerArmed(enabled)} hint="These keys become global shortcuts while armed." />
            <Range label="Step size" value={snapshot.clickerStep} min={0.01} max={0.5} step={0.01} format={percent} onChange={(clickerStep) => patch({ clickerStep })} />
            <Toggle
              label="Drive focused presentation"
              checked={snapshot.drivePresentation}
              disabled={!presentation?.ok}
              onChange={(enabled) => window.controlsApi.setPresentationArmed(enabled)}
              hint={presentation?.ok ? 'Also sends Left/Right to the focused presentation window.' : presentation?.reason ?? 'Capability unavailable.'}
            />
          </Panel>

          <SettingsPanel toast={showToast} confirm={askConfirm} />
          <HotkeysPanel
            bindings={snapshot.hotkeyBindings}
            failed={failedHotkeys}
            onUpdate={async (bindings: Record<HotkeyCommand, string>) => {
              await window.controlsApi.updateHotkeys(bindings)
              const status = await window.controlsApi.getHotkeyStatus()
              setFailedHotkeys(status.failed)
            }}
          />
        </div>

        <footer className="status" aria-live="polite">
          <span className={`status__pill ${snapshot.playing ? 'status__pill--on' : ''}`}>{snapshot.playing ? 'PLAYING' : 'PAUSED'}</span>
          <span className={`status__pill ${snapshot.overlayVisible ? 'status__pill--on' : ''}`}>overlay {snapshot.overlayVisible ? 'visible' : 'hidden'}</span>
          <span className={`status__pill ${snapshot.clickerMode ? 'status__pill--on' : ''}`}>clicker {snapshot.clickerMode ? 'armed' : 'off'}</span>
          <span className="status__document">{metadata ? `${metadata.name}${metadata.dirty ? ' • recovered script' : ''}` : 'No script loaded'}</span>
          <span className="status__storage" aria-label="Playlist and settings save status">
            {storageStatus.lastPersistedAt === null ? 'Not saved in this session' : (
              <>Playlist/settings saved <time dateTime={new Date(storageStatus.lastPersistedAt).toISOString()} title={new Date(storageStatus.lastPersistedAt).toLocaleString()}>{new Date(storageStatus.lastPersistedAt).toLocaleTimeString()}</time></>
            )}
          </span>
          {storageStatus.restoring && <span className="status__storage">Loading remaining files</span>}
        </footer>
      </main>
    </div>
    </>
  )
}

function PacingPanel({
  snapshot,
  wordCount,
  geometry,
  patch,
}: {
  snapshot: AppSnapshot
  wordCount: number
  geometry: { textH: number; viewportH: number }
  patch: (value: PreferencePatch) => void
}) {
  const range = Math.max(0, geometry.textH - geometry.viewportH)
  const duration = range > 0 ? range / Math.max(1, snapshot.scrollSpeed) : 0
  const currentWpm = duration > 0 ? (wordCount * 60) / duration : 0
  const [durationInput, setDurationInput] = useState('')
  const [wpmInput, setWpmInput] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDurationInput(snapshot.targetMode === 'duration' && snapshot.targetDurationSec ? formatDuration(snapshot.targetDurationSec) : '')
    setWpmInput(snapshot.targetMode === 'wpm' && snapshot.targetWpm ? Math.round(snapshot.targetWpm).toString() : '')
  }, [snapshot.targetMode, snapshot.targetDurationSec, snapshot.targetWpm])

  const commitDuration = () => {
    if (!durationInput.trim()) return
    const value = parseDuration(durationInput)
    if (value === null) {
      setError('Use mm:ss, h:mm:ss, or minutes such as 4.5.')
      return
    }
    setError(null)
    patch({ targetMode: 'duration', targetDurationSec: value, targetWpm: null })
  }

  const commitWpm = () => {
    const value = Number(wpmInput)
    if (!Number.isFinite(value) || value < 20 || value > 2000) {
      setError('Target WPM must be between 20 and 2000.')
      return
    }
    setError(null)
    patch({ targetMode: 'wpm', targetWpm: value, targetDurationSec: null })
  }

  return (
    <Panel title="Run & pacing">
      <Range
        label="Manual speed"
        value={snapshot.scrollSpeed}
        min={5}
        max={400}
        step={1}
        format={(value) => `${Math.round(value)} px/s`}
        onChange={(scrollSpeed) => patch({ scrollSpeed, targetMode: null, targetDurationSec: null, targetWpm: null })}
      />
      <div className="row">
        <label htmlFor="target-duration">Target time</label>
        <input id="target-duration" type="text" placeholder="mm:ss" value={durationInput} onChange={(event) => setDurationInput(event.target.value)} onBlur={commitDuration} onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()} />
      </div>
      <div className="row">
        <label htmlFor="target-wpm">Target WPM</label>
        <input id="target-wpm" type="number" min={20} max={2000} value={wpmInput} onChange={(event) => setWpmInput(event.target.value)} onBlur={commitWpm} onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()} />
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <p className="form-hint">
        {range > 0 ? `${wordCount.toLocaleString()} words · ${formatDuration(duration)} at ${Math.round(currentWpm)} WPM` : 'The estimate appears after the overlay measures the script.'}
      </p>
      {snapshot.targetMode && <button type="button" className="btn btn--ghost" onClick={() => patch({ targetMode: null, targetDurationSec: null, targetWpm: null })}>Clear {snapshot.targetMode} target</button>}
      <Toggle label="Countdown before play" checked={snapshot.countdownEnabled} onChange={(countdownEnabled) => patch({ countdownEnabled })} />
      <Range label="Countdown" value={snapshot.countdownSeconds} min={1} max={10} step={1} disabled={!snapshot.countdownEnabled} format={(value) => `${value}s`} onChange={(countdownSeconds) => patch({ countdownSeconds })} />
      <Toggle label="Show chronometer" checked={snapshot.showChronometer} onChange={(showChronometer) => patch({ showChronometer })} />
    </Panel>
  )
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function parseDuration(input: string): number | null {
  const value = input.trim()
  const hms = value.match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/)
  if (hms) {
    const [, hours, minutes, seconds] = hms
    const result = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
    return Number(minutes) < 60 && Number(seconds) < 60 && result > 0 ? result : null
  }
  const ms = value.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/)
  if (ms) {
    const result = Number(ms[1]) * 60 + Number(ms[2])
    return Number(ms[2]) < 60 && result > 0 ? result : null
  }
  const minutes = Number(value)
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : null
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const remainder = total % 60
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`
    : `${minutes}:${remainder.toString().padStart(2, '0')}`
}
