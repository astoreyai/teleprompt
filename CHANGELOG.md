# Changelog

## 1.0.1 — 2026-09-04

- Preserve pending editor text during native and renderer-initiated close, keep storage failures visible, and retain recoverable draft references.
- Bound renderer recovery across window replacements and reject delayed playback checkpoints after a seek.
- Repair PDF importing inside Electron's utility process; tighten archive validation and import admission.
- Refresh vulnerable dependencies and preserve sandboxing in the AppImage launcher.
- Add real-input packaged and measured stress checks. Full release qualification remains blocked on legacy test conversion and device/corpus coverage.

Notable user-visible and architectural changes are recorded here. Teleprompt follows semantic versioning from the 1.0 release onward.

## 1.0.0 — 2026-07-19

Teleprompt 1.0 is a reliability rebase of the original Linux desktop application. It is a Linux x64 release; Windows and macOS are not qualified targets.

### Added

- Durable private recovery drafts for every acknowledged unsaved edit.
- Stable document IDs, optimistic revisions, and serialized document mutations.
- Bounded multi-format imports through a killable Electron utility process.
- Atomic lossless-source saves, external-edit conflict detection, and Save a copy.
- Strict state schemas with backup recovery, invalid-state quarantine, and legacy migration.
- Role-specific controls and overlay APIs with exact IPC sender authorization.
- Bounded renderer recreation, startup issue reporting, local redacted diagnostics, and crash-artifact retention.
- Responsive, keyboard-accessible controls with explicit loading, recovery, conflict, platform, voice, and hotkey states.
- Unit and coverage gates, fused-binary Playwright recovery tests, repeated soak tests, artifact verification, checksums, and Linux CI.

### Fixed

- Stopped the `clean-exit` to `launch-failed` renderer reload loop observed in historical crash logs.
- Prevented extracted PDF, DOCX, ODT, RTF, HTML, SRT, and VTT text from overwriting the original structured source.
- Prevented delayed editor writes from landing on a different playlist item.
- Prevented rejected oversized edits from replacing the last valid draft.
- Made metadata persistence recover after a transient write failure instead of poisoning all later saves.
- Removed high-frequency full-workspace broadcasts during scrolling.
- Recovered from a corrupt primary state file when a valid backup exists.
- Contained parser, presentation-driver, and renderer failures at their owning process boundaries.

### Security and privacy

- Enabled renderer sandboxing, context isolation, navigation denial, a restrictive content security policy, a private production protocol, and hardened Electron fuses.
- Minimized overlay data and authority; it cannot access files, settings, recent paths, hotkey configuration, or microphone consent.
- Added regular-file-only, symlink-refusing, bounded reads and archive expansion safeguards.
- Made voice pacing explicitly consented, visible, revocable, and off after restart.
- Kept Crashpad local-only and bounded while scrubbing secret-like environment values before startup.

### Known constraints

- Release artifacts are unsigned and there is no automatic update channel.
- Linux cannot exclude the overlay from screen capture through Electron.
- Presentation driving is X11-only and requires `xdotool`; Wayland window and global-hotkey behavior varies by compositor.
- Voice recognition availability and service privacy depend on Chromium and the host platform.
- Image-only PDFs are rejected, and transformed document imports preserve text rather than source layout.

See [the architectural review](docs/ARCHITECTURE_REVIEW.md) for evidence, severity, remediation, and residual risk details.
