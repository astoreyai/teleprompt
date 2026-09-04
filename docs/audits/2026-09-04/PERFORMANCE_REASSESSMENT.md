# Performance and CI reassessment — 2026-09-04

Baseline source: `70f4ab17a8cff9c4501bde8ee6020f6290459c0b`, installed Teleprompt 1.0.1. The initial 7.2 GiB figure was summed process RSS during a pathological automation operation. It must not be presented as normal paste performance, unique physical memory, or proof of a leak.

## Confirmed insertion diagnosis

The same installed application and real TypeScript declaration file (588,085 bytes, SHA-256 `e134052a6b1ded61693b4037f615dc72f14e2881e79c1ddbff6c514c8a516b05`) produced:

| Observed operation | Duration | Layouts | Style recalculations |
| --- | ---: | ---: | ---: |
| Playwright `fill`, using Chromium CDP `Input.insertText` | 175,678 ms | 34,308 | 57,182 |
| Native X11 clipboard paste | 206 ms, plus 26 ms for exact-value confirmation | 4 | 8 |

The control renderer spent 58.6 seconds in layout during CDP insertion; its JavaScript heap was only 8.2 MiB. This confirms a native layout bottleneck in that insertion path. Playwright maintainers describe the same per-line layout behavior in [issue 33761](https://github.com/microsoft/playwright/issues/33761). The diagnostic observations and real input provenance are in [insertion-diagnosis.json](evidence/performance/insertion-diagnosis.json).

The native allocations were real. The original measurement was misleading because the interaction was not representative and summed RSS counts shared mappings repeatedly. Earlier samplers also missed descendants launched by threads other than the process leader; their memory figures are partial-tree observations. The corrected stress test follows every thread's children and reads RSS, proportional-set size, and private pages from `smaps_rollup`. These are sampled live-descendant totals, not an atomic snapshot or a hard limit; detached Crashpad processes are outside that tree. See the Linux [proc accounting documentation](https://man7.org/linux/man-pages/man5/proc_pid_status.5.html).

## Confirmed application retention and correction

Native paste still exposed a separate retention problem: leaving the real 9 MB TypeScript implementation document retained substantial unused renderer memory. On installed 1.0.1, the focused transition test failed its 512 MiB private-memory ceiling with 1,017,323,520 bytes after the 15-second wait. This observation used the earlier partial-tree sampler, so omitted memory cannot explain the failure away.

The preload now asks Chromium to release unused resources after content shrinks to at most one quarter of a preceding document of at least 500,000 characters. The request is deferred 250 ms and cancelled/rescheduled when content changes. It observes both document events and bootstrap content, including restored windows. It uses Electron's [webFrame.clearCache](https://www.electronjs.org/docs/latest/api/web-frame), whose [43.1.1 implementation](https://github.com/electron/electron/blob/v43.1.1/shell/renderer/api/electron_api_web_frame.cc) clears Blink's cache and signals critical memory pressure within the renderer process. It does not erase application documents or deliberately reset the native Undo stack.

Review reproduced a gap in the first candidate: a restored large document bypassed event-only tracking, retaining 1,000,677,376 bytes after switching small. Including bootstrap content fixed that case. Both new and restored document tests now pass with the corrected process sampler, and actual native Undo/Redo restores the exact declaration and README bytes. The combined runtime gate progressed from 18/18 before adding the restoration case to 20/20 after correction, with retries disabled, zero failures, zero skips, and zero flaky cases. The reviewed unit subset remains 80/80; this is not full coverage qualification.

No IPC shape, persistent schema, or stored document representation changes. The bundled controls and overlay still consume the existing bootstrap and document-event contracts. The installed older client continues to read schema v2. The cleanup is not a memory ceiling for a large active document or an indefinitely growing native Undo history.

A CSS layer-promotion experiment was discarded: removing `will-change` did not improve the observed large-document peak. No production CSS change was retained.

## GitHub verification failure

Confirmed remote failures [33924658323](https://github.com/astoreyai/teleprompt/actions/runs/33924658323) and [33924698291](https://github.com/astoreyai/teleprompt/actions/runs/33924698291) stop at **Require reviewed real-input release qualification**. Dependency installation, dependency audit, and Node 22 typechecking succeeded. The guard exits 1 locally for the same nine suites: diagnostic-log, documents/save-service, lifecycle/crash-retention, parser/parser-core, parser/supervisor, persistence/schema, presentation, shared/cues, and shared/text.

The guard remains enforced. Legacy fabricated fixtures cannot be certified under the user's real-data rule, and their assertions have not been removed to obtain a green result. Genuine domain and malformed-input evidence is still required for the remaining conversions. CI also lacks configured genuine DOCX/PDF inputs; private local documents used for runtime verification have not been published.

The workflow now installs `xclip` and invokes the packaged runner, which exports its private Xvfb display marker. This fixes the new native-clipboard tests' CI invocation requirements, but does not remove the independent qualification and corpus blockers.

To complete CI: obtain publishable genuine documents covering the unqualified paths; convert and execute the nine suites without fabricated values or process doubles; record reviewed suite hashes only after execution; configure the real DOCX/PDF inputs; then run full coverage and packaged qualification on GitHub. Current red qualification is deliberate and must remain visible until those requirements are met.

KOS context was checked with 90 referenced objects and no missing ids. It contained no accepted facts. Historical audit-scope decisions `dec_c2546cf00175` and `dec_cd05593e1f93` are superseded by the user's implementation and deployment instructions.

## Five-minute comparison of the exact packages

Confirmed: both sequential runs passed content hashing, actual persistence/restart checks, and the ten-second maximum cycle gate. Input byte counts, SHA-256 values, and mtimes matched exactly. Each import burst admitted 18 real file requests and refused six. The 1.0.2 archive tested was `8011bb23da68abfe01cb8f1370bbff3dc2cde983f288839b721f1d6b92c2de52`.

| Observation | Installed 1.0.1 | Packaged 1.0.2 |
| --- | ---: | ---: |
| Completed edit/layout/playback cycles | 387 | 385 |
| Full-run peak private memory | 2.35 GiB | 1.64 GiB |
| Median private memory, seconds 30–60 | 1.48 GiB | 0.41 GiB |
| Median private memory, seconds 120–150 | 1.89 GiB | 0.66 GiB |
| Median private memory, seconds 270–300 | 2.26 GiB | 1.02 GiB |
| Median complete cycle | 282 ms | 275 ms |
| 95th-percentile complete cycle | 393 ms | 409 ms |
| Slowest complete cycle | 798 ms | 617 ms |
| 95th-percentile native paste/confirmation | 197 ms | 233 ms |

The late-window private-memory reduction is 55%; the full-run peak reduction is 30%. These are observations from one paired workload, not hardware-independent limits or statistical estimates. The 1.0.2 full-run peak occurred at 4.7 seconds while initially rendering the large document; the 1.0.1 peak occurred at 302.3 seconds. Cycle and paste timings do not establish an overall latency improvement: the observed 95th percentiles increased while maxima decreased.

Memory still grows during repeated whole-document replacement. A separate actual Undo/GC probe confirmed that native history retains DOM state, but does not prove all sustained growth comes from that history. This patch releases unused state and preserves current Undo semantics; it does not establish complete containment. Bounding Undo history changes user-visible behavior and requires a policy decision before implementation. Rendering only the visible portion of a very large active document also needs a reviewed design that preserves playback distance, seeks, cue positions, and text selection.

The clock origin for the table's memory windows is the start of sampling after launch; the requested editing window is five minutes, and total runs were approximately 308 seconds including setup and restart. Measurements used isolated Xvfb with GPU disabled, not the user's physical compositor. Original input provenance and every memory sample are preserved in [1.0.1 measurements](evidence/performance/native-stress-1.0.1.json), [1.0.2 measurements](evidence/performance/native-stress-1.0.2.json), [comparison.json](evidence/performance/comparison.json), and [environment.json](evidence/performance/environment.json).

## Installed and distributable qualification

Confirmed installation upgraded only Teleprompt from 1.0.1 to 1.0.2. `dpkg -V teleprompt` exited 0 with no differences. The installed and extracted AppImage application archives both match the stress-tested 1.0.2 archive above. The artifact verifier passed, and the extracted AppRun exactly matches `build/AppRun`. The installed sandbox helper remains root-owned mode 0755 and uses this host's supported namespaces; no sandbox-disable flag was added. As in 1.0.1, the package skipped its unsupported AppArmor profile on this host.

Final results: **80/80 reviewed unit tests**, **20/20 installed runtime cases** (two repeats), and **10/10 extracted AppImage runtime cases**, with retries disabled and no failures, skips, or flaky cases. Typecheck and dependency audit exited 0; the audit reported zero vulnerabilities. A separate short stress smoke run against `/opt/Teleprompt/teleprompt` completed 13 cycles over a requested ten-second editing window and passed content/restart checks. It is additional installed-path verification, not a second five-minute comparison. FUSE mounting and the physical microphone/compositor were not exercised.

Machine-readable [verification](evidence/performance/verification-1.0.2.json), [installed stress smoke](evidence/performance/installed-stress-1.0.2.json), and [distribution hashes](evidence/performance/artifacts-1.0.2.json) record the observed results. Full qualification still exits 1 for the same nine legacy suites, so the release remains a prerelease.

Rollback: close Teleprompt and reinstall the checksum-verified 1.0.1 Debian package retained under `.release-local/1.0.1/`, allowing downgrade. Revert the 1.0.2 release commit to restore source behavior. The profile schema is unchanged; performance/crash probes used disposable profiles and copies. Private corpus paths, profiles, and full local traces remain excluded from publication.
