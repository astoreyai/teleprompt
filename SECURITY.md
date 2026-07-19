# Security policy

## Supported version

Security fixes target the current 1.x Linux x64 release line.

## Report a vulnerability

Use the repository's private GitHub security advisory flow. Include the affected version, threat scenario, reproduction, and whether exploitation requires a user-selected file or local machine access. Do not attach documents, drafts, crash dumps, or logs containing confidential script content without reviewing them first.

## Threat model

Teleprompt treats imported documents, persisted state, renderer content, dropped paths, and IPC payloads as untrusted. The main assets are script confidentiality, recovery-draft integrity, source-file integrity, microphone privacy, and availability during a live presentation.

The controls renderer has explicit document/settings authority. The transparent overlay is considered more exposed because it is always on top and interactive, so it receives a smaller capability set. Local users with access to the same account and operating-system-level compromise are outside the application boundary.

## Controls

- Sandboxed, context-isolated renderers with Node integration disabled.
- Separate typed preloads for controls and overlay; no generic IPC bridge.
- Exact channel, role, top-frame, and renderer-origin authorization in the main process.
- Navigation, popups, and webviews denied; restrictive renderer CSP; Markdown sanitized with DOMPurify.
- Private custom production protocol and ASAR-only loading with embedded integrity validation.
- Node execution, `NODE_OPTIONS`, Node inspector CLI arguments, and privileged `file://` behavior disabled through Electron fuses.
- Regular-file-only, symlink-refusing, nonblocking, bounded reads.
- Concurrency, input, output, timeout, ZIP entry, expansion, and compression-ratio limits for document parsing in a killable utility process.
- Source hash and modification-time checks before overwrite; temporary-file write, file fsync, atomic rename, and best-effort directory fsync.
- Private state/draft permissions, strict versioned parsing, backup recovery, and quarantine for invalid state.
- Fail-fast main-process error policy and bounded renderer recovery with backoff.
- Secret-like environment variables scrubbed before local Crashpad startup; no crash upload; bounded crash retention and redacted logs.

## Data and privacy

Document contents are held in memory while open. Unsaved changes are also written as private local recovery drafts so they can survive a crash. Controls receive a content-free workspace snapshot. The overlay receives a smaller rendering projection with no source/recent paths, hotkeys, consent, or unrelated document metadata. Only the active document body is sent separately to the two trusted application surfaces.

Voice pacing requests audio-only permission only from the controls top frame after explicit consent. Depending on Chromium and the platform, recognition may use a network speech provider. Voice activity is never restored after restart, and consent can be revoked in the UI.

## Residual risks

- Release artifacts are not code-signed and there is no in-app updater; verify SHA-256 checksums from the release workflow.
- Web Speech Recognition has platform-dependent availability and service/privacy behavior.
- X11 global shortcuts and `xdotool` deliberately affect desktop-global input when armed.
- Linux does not provide Electron content-protection support; do not rely on Teleprompt to keep the overlay out of recordings.
- Complex document parsing libraries remain a supply-chain and parser-risk surface despite isolation and limits. Keep dependencies current and rerun audit, parser fixtures, and packaged tests for each release.
