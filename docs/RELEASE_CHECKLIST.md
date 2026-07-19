# Linux x64 release checklist

## Automated gates

- [ ] Use Node.js 22.12 or the version pinned in CI.
- [ ] Start from `npm ci`; do not release from a drifted dependency tree.
- [ ] `npm audit --audit-level=high` reports no high/critical vulnerabilities.
- [ ] `npm run typecheck` passes.
- [ ] `npm run test:coverage` passes configured statement, branch, function, and line thresholds.
- [ ] `npm run test:e2e` passes against the fused unpacked product.
- [ ] `npm run test:soak` completes all repeated import, restart, playback, and renderer-crash scenarios.
- [ ] `npm run package` produces AppImage, deb, and tar.gz artifacts.
- [ ] `npm run verify:artifact` confirms the required fuses and ASAR-only layout.
- [ ] SHA-256 checksums cover every distributed artifact.

## Manual product smoke test

- [ ] Open and restore a text file, Markdown file, DOCX/ODT, and text PDF.
- [ ] Confirm PDF/DOCX/ODT Save opens Save As and leaves the source byte-identical.
- [ ] Externally edit a loaded text file, then confirm Teleprompt refuses overwrite and Save a copy works.
- [ ] Create an unsaved document, terminate the process, relaunch, and confirm the exact draft restores paused.
- [ ] Exercise play/pause/restart, duration target, WPM target, manual speed, cues, countdown, mirror modes, banner, focus mode, and click-through.
- [ ] Verify controls remain operable at 560×360 and with keyboard-only navigation.
- [ ] Verify all global shortcut failures are surfaced rather than silently ignored.
- [ ] On X11 with `xdotool`, arm presentation drive and confirm it sends only the documented left/right actions.
- [ ] Grant, exercise, stop, and revoke voice pacing; confirm the status is visible and it remains off after restart.
- [ ] Confirm Linux capture-protection limitation and Wayland limitation text are visible and accurate.

## Distribution

- [ ] Version, release notes, artifact names, and checksum file agree.
- [ ] Release notes state Linux x64 only, unsigned artifacts, no auto-update, and current residual limitations.
- [ ] Install and uninstall the deb on a clean supported distribution.
- [ ] Run the packaged E2E suite against `/opt/Teleprompt/teleprompt` using `TELEPROMPT_E2E_EXECUTABLE`.
- [ ] Run the AppImage on a second supported distribution or clean VM.
- [ ] Extract and launch the tar.gz artifact.
- [ ] Preserve the previous known-good artifacts and checksums for rollback.
