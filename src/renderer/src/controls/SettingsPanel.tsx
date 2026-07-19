import { useEffect, useState } from 'react'
import type { AppAbout } from '../../../shared/ipc'
import { Panel, type ConfirmRequest } from './ui'

export function SettingsPanel({
  toast,
  confirm,
}: {
  toast: (message: string) => void
  confirm: (request: Omit<ConfirmRequest, 'resolve'>) => Promise<boolean>
}) {
  const [about, setAbout] = useState<AppAbout | null>(null)

  useEffect(() => {
    void window.controlsApi.getAbout().then(setAbout).catch(() => setAbout(null))
  }, [])

  const reset = async () => {
    if (
      !(await confirm({
        title: 'Reset display preferences?',
        body: 'This restores display, pacing, and shortcut preferences. Your scripts and recovery drafts are preserved.',
        confirmLabel: 'Reset preferences',
        danger: true,
      }))
    ) return
    await window.controlsApi.resetPreferences()
    toast('Preferences reset')
  }

  const clearRecent = async () => {
    if (
      !(await confirm({
        title: 'Clear recent files?',
        body: 'This removes recent-file shortcuts. Loaded scripts and recovery drafts are preserved.',
        confirmLabel: 'Clear recent files',
      }))
    ) return
    await window.controlsApi.clearRecentFiles()
    toast('Recent files cleared')
  }

  return (
    <Panel title="Preferences & diagnostics" defaultCollapsed>
      <div className="button-row">
        <button
          type="button"
          className="btn"
          onClick={async () => {
            const result = await window.controlsApi.exportPreferences()
            if (result.ok) toast(`Preferences exported${result.path ? ` to ${result.path}` : ''}`)
            else if (result.error !== 'cancelled') toast(`Export failed: ${result.error ?? 'unknown error'}`)
          }}
        >
          Export preferences
        </button>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            const result = await window.controlsApi.importPreferences()
            if (result.ok) toast('Preferences imported')
            else if (result.error !== 'cancelled') toast(`Import failed: ${result.error ?? 'unknown error'}`)
          }}
        >
          Import preferences
        </button>
        <button type="button" className="btn" onClick={() => void clearRecent()}>
          Clear recent files
        </button>
        <button type="button" className="btn btn--danger" onClick={() => void reset()}>
          Reset preferences
        </button>
      </div>
      {about && (
        <dl className="about-list">
          <div><dt>Teleprompt</dt><dd>{about.appVersion}</dd></div>
          <div><dt>Electron</dt><dd>{about.electronVersion}</dd></div>
          <div><dt>Node</dt><dd>{about.nodeVersion}</dd></div>
          <div><dt>State</dt><dd title={about.storePath}>{about.storePath}</dd></div>
        </dl>
      )}
    </Panel>
  )
}
