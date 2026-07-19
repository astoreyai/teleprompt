import { useState } from 'react'
import { DEFAULT_HOTKEYS, HOTKEY_LABELS, type HotkeyCommand } from '../../../shared/types'
import { Panel } from './ui'

function acceleratorFromKey(event: React.KeyboardEvent): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return null
  const parts: string[] = []
  if (event.ctrlKey || event.metaKey) parts.push('CommandOrControl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  const aliases: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ' ': 'Space',
    Enter: 'Return',
  }
  const key =
    event.key.length === 1
      ? event.key.toUpperCase()
      : aliases[event.key] ?? (/^F\d{1,2}$/.test(event.key) ? event.key : event.key)
  if (!/^(?:[A-Z0-9]|F\d{1,2}|Up|Down|Left|Right|Space|Return|Escape|PageUp|PageDown|Home|End|Backspace|Delete|Insert|Tab)$/.test(key)) {
    return null
  }
  parts.push(key)
  return parts.join('+')
}

function prettyAccelerator(value: string): string {
  return value
    .replace(/CommandOrControl/g, 'Ctrl')
    .replace(/\+Up\b/g, '+↑')
    .replace(/\+Down\b/g, '+↓')
    .replace(/\+Left\b/g, '+←')
    .replace(/\+Right\b/g, '+→')
}

export function HotkeysPanel({
  bindings,
  failed,
  onUpdate,
}: {
  bindings: Record<HotkeyCommand, string>
  failed: string[]
  onUpdate: (bindings: Record<HotkeyCommand, string>) => Promise<void>
}) {
  const [editing, setEditing] = useState<HotkeyCommand | null>(null)
  const [hint, setHint] = useState<string | null>(null)

  const commit = async (command: HotkeyCommand, accelerator: string) => {
    const next = { ...bindings, [command]: accelerator }
    if (new Set(Object.values(next)).size !== Object.values(next).length) {
      setHint(`${prettyAccelerator(accelerator)} is already assigned.`)
      return
    }
    await onUpdate(next)
    setEditing(null)
    setHint(null)
  }

  return (
    <Panel title="Hotkeys" defaultCollapsed>
      {failed.length > 0 && (
        <div className="inline-error" role="status">
          {failed.length} shortcut{failed.length === 1 ? '' : 's'} could not register: {' '}
          {failed.map(prettyAccelerator).join(', ')}
        </div>
      )}
      <div className="hotkey-rows">
        {(Object.keys(DEFAULT_HOTKEYS) as HotkeyCommand[]).map((command) => {
          const accelerator = bindings[command] ?? DEFAULT_HOTKEYS[command]
          return (
            <div key={command} className="hotkey-row">
              <span className="hotkey-row__label">{HOTKEY_LABELS[command]}</span>
              {editing === command ? (
                <input
                  className="hotkey-row__capture"
                  aria-label={`New shortcut for ${HOTKEY_LABELS[command]}`}
                  autoFocus
                  readOnly
                  value="press keys…"
                  onKeyDown={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    if (event.key === 'Escape') {
                      setEditing(null)
                      setHint(null)
                      return
                    }
                    const accelerator = acceleratorFromKey(event)
                    if (accelerator) void commit(command, accelerator)
                  }}
                  onBlur={() => setEditing(null)}
                />
              ) : (
                <button
                  type="button"
                  className={`hotkey-row__accel ${failed.includes(accelerator) ? 'hotkey-row__accel--failed' : ''}`}
                  onClick={() => {
                    setEditing(command)
                    setHint('Press a shortcut, or Escape to cancel.')
                  }}
                >
                  {prettyAccelerator(accelerator)}
                </button>
              )}
              {accelerator !== DEFAULT_HOTKEYS[command] && (
                <button
                  type="button"
                  className="hotkey-row__reset"
                  aria-label={`Reset ${HOTKEY_LABELS[command]}`}
                  onClick={() => void commit(command, DEFAULT_HOTKEYS[command])}
                >
                  ↺
                </button>
              )}
            </div>
          )
        })}
      </div>
      {hint && <p className="form-hint" role="status">{hint}</p>}
      <p className="form-hint">Ctrl+Alt+1–9 jumps to cues. Page Up/Down is reserved while clicker mode is armed.</p>
      <button type="button" className="btn btn--ghost" onClick={() => void onUpdate({ ...DEFAULT_HOTKEYS })}>
        Reset all shortcuts
      </button>
    </Panel>
  )
}
