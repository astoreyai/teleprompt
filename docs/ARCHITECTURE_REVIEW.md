# Architectural review and remediation record

Date: 2026-07-18
Scope: Electron main/preload/renderer, state and persistence, all file entry points, parser isolation, playback, integrations, security, observability, packaging, and deployment.

Review method: direct repository and artifact inspection, historical crash-log/coredump evidence, focused reproduction, and independent crash-reliability, frontend-contract/HCI, and security-platform reviews. The independent reviews converged on the same priorities: stop destructive saves, remove full-content playback broadcasts, isolate parsing and renderer roles, make drafts durable, and bound recovery.

## Outcome

The reviewed 0.1.x architecture was not safe to ship: it contained a reproducible renderer recovery loop, destructive save semantics for extracted binary formats, index-based asynchronous state hazards, synchronous/unbounded work in privileged paths, and high-frequency full-state broadcasts. The program has been rebased onto a versioned, bounded, role-isolated architecture and is now a deployable Linux x64 1.0 product subject to the residual limitations below.

Historical diagnostics repeatedly recorded `clean-exit` followed immediately by renderer `launch-failed` with exit code 1002. The former lifecycle handler attempted an immediate in-place reload for every `render-process-gone` event, including clean exits. That reload raced teardown and could create a self-sustaining launch-failure loop. Historical native dumps also included SIGILL/SIGSEGV terminations. The lifecycle loop is the evidence-backed application defect; the exact native instruction fault cannot be attributed from the retained symbols alone.

## Findings and resolutions

| Severity | Finding in reviewed design | Impact | Implemented resolution | Regression evidence |
| --- | --- | --- | --- | --- |
| P0 | Every renderer termination triggered synchronous in-place reload | clean-exit → launch-failed crash loop | reason-aware recovery, window recreation for hard failures, backoff/budget, shutdown suppression | recovery-policy unit tests and forced packaged `Page.crash` |
| P0 | Save wrote extracted text back to DOCX/PDF/ODT/RTF/HTML/subtitle source paths | irreversible source corruption | lossless-format policy, Save As for transformed imports, source conflict guard, atomic writes | save-service matrix and packaged external-edit test |
| P0 | Playlist-index asynchronous edits could land on a different item | silent cross-document corruption | stable document IDs plus expected revisions and serialized mutations | workspace delayed-edit regression |
| P0 | Acknowledged edits depended on delayed metadata persistence | draft could become orphaned after main crash | draft-first write and critical metadata commit before IPC return | crash-durability AppStore regression |
| P1 | Rejected workspace-limit updates could replace the last valid draft; one failed metadata save poisoned all later saves | rejected text could reappear and persistence could stop permanently | preflight before draft write and retryable serialized persistence chain | AppStore limit/retry regressions |
| P1 | Full application state, including every script body, was broadcast at playback cadence | clone/GC/IPC pressure and renderer instability | content-free snapshot, separate active-content event, local RAF, 250 ms scalar checkpoints | snapshot serialization assertions and packaged playback test |
| P1 | Parsing and large reads occurred in privileged process paths without uniform limits | hangs, memory exhaustion, parser crash could take down app | one bounded importer, regular-file reader, semaphore, killable utility process, timeout/output/ZIP limits | reader/import/parser/supervisor/ZIP tests and packaged importer test |
| P1 | Uncaught main errors were logged and execution continued | corrupted authority state | fail-fast shutdown with bounded persistence flush | lifecycle design inspection and graceful process E2E |
| P1 | Corrupt primary metadata skipped a valid backup | unnecessary workspace loss | primary → backup → legacy recovery with quarantine | repository backup regression |
| P1 | Preload exposed broad shared authority and sender checks used mutable current URL | privilege confusion, authorization bypass, and controls-only metadata exposure | distinct semantic role APIs, minimized overlay read model, and exact static route/top-frame/channel manifest | projection/IPC policy tests and packaged surface-isolation tests |
| P1 | Production packaging lacked enforceable Electron hardening | runtime flags could reopen privileged surfaces | strict Electron fuses, custom secure protocol, ASAR integrity/only-app loading, artifact verifier | packaged fuse-wire verification |
| P2 | Crash and diagnostic artifacts were unbounded | disk growth and accidental secret retention | local-only Crashpad, environment scrubbing, seven-day/ten-artifact retention including `.meta`, redacted 512 KiB log rotation | diagnostic and retention tests |
| P2 | Responsive control layout breakpoint was unreachable | operator controls failed on narrower displays | minimum controls width reduced to 560 px and persisted bounds normalized | schema regression and responsive CSS |
| P2 | Voice token progress included removed cue markup | inaccurate pacing jumps | cue-stripped progress calculation and clamping | voice progress unit test |
| P2 | Voice consent could be granted but not revoked | incomplete privacy control | typed revoke command, immediate durable preference flush, UI control | controller regression and IPC manifest |
| P2 | Large rich rendering/token arrays and unbounded cue records amplified renderer memory | avoidable OOM/recovery churn | 500k interactive caps, plain-text fallback, scanning word count, bounded cues, voice state-machine enforcement | text/cue/render/controller regressions |
| P2 | Detached `xdotool` and parser cleanup errors could escape asynchronously | optional integration/cleanup race could terminate main | trusted absolute executable resolution and child/worker error containment | presentation and supervisor regressions |
| P2 | Missing state was reported as a legacy migration | false first-launch warning | distinct clean-default parse path | schema first-launch regression |

## Architectural assessment by area

### Main process and backend

Authority is now partitioned into domain workspace, application store/controller, file import/save services, repositories, lifecycle policy, platform adapters, and role-aware IPC. Mutations are serialized where persistence ordering matters. File paths do not bypass the importer based on whether they came from a picker, drag/drop, recent list, CLI, file association, restore, or reload.

### Frontend and product workflow

Controls and overlay have explicit loading, fatal-error, conflict, dirty-draft, startup-issue, hotkey-failure, voice-status, and platform-capability states. The editor uses revisioned queued flushes. Controls are keyboard-focus visible, labeled, responsive, and reduced-motion aware. Manual speed remains available even when pacing targets are configured. Destructive reload/remove actions are confirmed and explain draft consequences.

### Security and privacy

The most exposed surface—the transparent overlay—cannot open/save files, change settings, arm integrations, update hotkeys, or request microphone access. Its read model also excludes source/recent paths, hotkeys, consent, and unrelated document metadata. All file operations are bounded and symlink-aware. Markdown is sanitized. Microphone permission is audio-only, controls-top-frame-only, explicit, visible, revocable, and off after restart. Draft content exists on disk by design and is documented accurately.

### Operations and release

The program now has structured startup recovery, bounded diagnostics, deterministic fatal behavior, verified hardened artifacts, locked dependencies, coverage gates, packaged process-boundary tests, repeated soak tests, and a release checklist. The release target is truthful: Linux x64 only.

## Residual risks and next releases

1. Artifacts are unsigned and lack an auto-update channel. Distribute checksums out of band and add signing before targeting less technical users.
2. Web Speech Recognition availability and data processing depend on Chromium/platform services. A local speech provider would materially improve privacy and predictability.
3. Wayland compositor behavior for always-on-top windows and global hotkeys remains inconsistent; `xdotool` presentation drive is X11-only.
4. Linux cannot enforce screen-capture exclusion through Electron.
5. RTF/HTML/subtitle extraction is text-oriented, and image-only PDFs are rejected. Expand format fixtures rather than claiming layout fidelity.
6. Windows and macOS packages, signing, permissions, and E2E have not been qualified and are not release claims.

## Definition of done

Release readiness requires all of the following to pass from a locked install:

```bash
npm audit --audit-level=high
npm run typecheck
npm run test:coverage
npm run test:e2e
npm run test:soak
npm run package
```

The release checklist in [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) adds manual presentation and artifact checks that CI cannot fully simulate.
