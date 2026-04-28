# Teleprompt

Transparent screen-overlay teleprompter for Linux/Win/Mac. Multi-file playlist, voice-paced auto-scroll, screen-capture hiding, cue points, markdown + docx ingest. Built on Electron + React + TypeScript.

## Quick start

```bash
npm install
npm run dev
```

Two windows open:
- **Overlay** — frameless, transparent, always-on-top. Hover near the top edge to reveal a drag handle. Double-click the text to jump straight into the editor.
- **Controls** — playlist, sliders, toggles, hotkey reference, settings.

## Features

### Reading
- Multi-file playlist (`.txt`, `.md`, `.rtf`, `.docx`) via file picker or drag-and-drop; recent paths persist
- Variable opacity (5–100%) + background dim
- Auto-scroll, 5–400 px/s
- Typography: font size, family, color, drop-shadow
- Markdown rendering (sanitized via DOMPurify) — headings, lists, blockquotes, inline code
- Eye-line marker + focus mode (masks lines outside the eye-line band)
- Mirror modes: horizontal (beam-splitter rigs) and vertical
- Banner / lower-third mode — single-line horizontal ticker at top or bottom
- RTL — `dir="auto"` on text containers; per-paragraph direction detection
- Chronometer in overlay corner: elapsed · time-to-end · target WPM
- 3-2-1 countdown before play (configurable seconds, only when starting from the top)
- Cue points — `[[CUE: name]]` markers become a clickable list and bind to `Ctrl+Alt+1..9`; optional in-overlay cue HUD shows the upcoming list with the current cue highlighted

### Editing
- Live edit pane — debounced (200 ms) writes to in-memory state; save back to disk (or save-as for new scripts)
- Edit-while-prompting — double-click overlay text to open the editor and focus the controls window

### Overlay behavior
- Click-through mode — mouse passes through to apps below
- Hide from screen capture — `setContentProtection` (macOS / Windows; Linux unsupported and indicated in UI)
- Per-window geometry persistence; bounds clamped to current displays on launch

### Input
- Global hotkeys (see table below); rebindable per-command from the Hotkeys panel
- Clicker mode — registers `PageUp` / `PageDown` globally to step scroll by a configurable amount; opt-in toggle
- Voice pacing — Web Speech API matches your spoken words against the script and auto-advances. Requires consent on first enable (styled modal); status pill reads "voice (cloud)" while active because Chromium routes audio to Google for transcription

### Settings
- Reset to defaults (with confirm)
- Export / import config (JSON)
- About: app, electron, node versions; on-disk store path

## Hotkeys

Default bindings:

| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+Space` | Play / Pause |
| `Ctrl+Alt+↑` / `↓` | Speed +/- |
| `Ctrl+Alt+]` / `[` | Opacity +/- |
| `Ctrl+Alt+→` / `←` | Next / Prev file |
| `Ctrl+Alt+H` | Hide / Show overlay (recreates if closed) |
| `Ctrl+Alt+T` | Toggle click-through |
| `Ctrl+Alt+R` | Restart from top |
| `Ctrl+Alt+1..9` | Jump to cue 1–9 (fixed, not rebindable) |
| `PageUp` / `PageDown` | Step back/forward (clicker mode, fixed) |

Each binding (except cue jumps and clicker keys) is **rebindable** in the Hotkeys panel — click an accelerator to capture a new key combo, or hit `↺` next to it to restore default. Failed registrations (held by another app or the compositor) are listed in red.

## Build

```bash
npm run build       # transpile main/preload/renderer
npm run package     # build + electron-builder distributables
npm run typecheck
```

## Architecture

```
src/
├── main/         Electron main process — windows, IPC, hotkeys, electron-store state
├── preload/      contextBridge → window.api
├── shared/       AppState, cue parser (used by main + both renderers)
└── renderer/
    ├── overlay.html  + src/overlay/    Transparent scrolling window
    ├── controls.html + src/controls/   Control panel
    └── src/shared/voice.ts             Web Speech API + sliding-window alignment
```

- State lives in the main process (`electron-store` with debounced 250 ms disk writes); broadcast to both renderers on every patch.
- Persistence stores file **paths** only — file contents are re-read on launch and never touch disk via electron-store.
- Auto-scroll is driven by a single RAF loop in the overlay with a `liveRef` snapshot of state and 50 ms-throttled IPC dispatch back to main; echo-suppression prevents the writer from reprocessing its own update.

## Security posture

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` on both BrowserWindows
- `setWindowOpenHandler({ action: 'deny' })` and `will-navigate` blocking external URLs
- Strict Content-Security-Policy (per-directive, no `'unsafe-inline'` on scripts)
- DOMPurify sanitizes markdown HTML before injection
- IPC handlers validate every input against an explicit `PATCHABLE_KEYS` allowlist with type checks and range clamping
- `files:loadPath` rejects paths outside the recent set, session-allowed set, or whitelisted extensions
- `files:save` to non-session-allowed paths is forced through a save dialog
- Permission request handler allows only `media` (mic for voice pacing); all others denied
- Path-only persistence keeps file contents off disk via `electron-store`

## Platform notes

- **Wayland**: `alwaysOnTop`, global hotkeys, and screen-capture hiding behave inconsistently across compositors. The Controls window shows a banner on Wayland; XWayland is the most predictable fallback.
- **Linux generally**: `setContentProtection` is a no-op on Linux (Electron limitation). The toggle is disabled with an explanation.
- **Voice pacing**: `webkitSpeechRecognition` in Electron 41 routes audio to Google for transcription. First-enable shows a consent dialog. The status pill reads `voice (cloud)` while active.

## Known limitations

- RTF parsing is hand-rolled; complex RTF (embedded objects, tables) may strip imperfectly. Use `.docx` for higher-fidelity source.
- Voice pacing is cloud STT (Chromium routes audio to Google). No local fallback yet.
- `Ctrl+Alt+1..9` (cue jumps) and `PageUp` / `PageDown` (clicker) are not rebindable in v1.
