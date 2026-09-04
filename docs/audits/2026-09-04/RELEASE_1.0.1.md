# Teleprompt 1.0.1 installation and stress qualification

The user authorized push, deployment, installation and stress testing on 2026-09-04. This report records observed qualification limits; it is not a full release sign-off.

## Installation

Confirmed: the installed Debian package was upgraded from 1.0.0 to 1.0.1. The apt simulation and installation changed only Teleprompt. The installed `/opt/Teleprompt/resources/app.asar` SHA-256 matches the built application: `1dc25e388f2631697ac59d0088859786d7fc399268459cbf08681ea6c91da8b7`. The artifact layout, reviewed sandbox-preserving AppRun and fuse settings passed `scripts/verify-artifact.mjs` against both the build and installed directory. Linux does not enforce Electron's ASAR runtime integrity setting.

The old installed application archive matched the saved 1.0.0 Debian package before installation. A private rollback package and user-profile archive are retained under `.release-local/rollback/`. Restore by closing Teleprompt and reinstalling that Debian package with downgrade allowed; restore the saved profile only if required. The persistent schema remains v2. Stress and crash tests use disposable profiles, not the live user profile.

The package's maintainer script reported that its bundled AppArmor profile was unsupported on this host and skipped that profile. The installed sandbox helper is root-owned mode 0755; the application launched in this host's supported namespace environment without `--no-sandbox`.

## Gates and limitations

Confirmed before installation: the selected real-input unit gate passed 80/80 tests in 19 suites, with no failures or skips; typecheck and build exited 0; npm audit reported zero vulnerabilities. The preceding implementation gate also passed 16/16 repeated packaged checks and 8/8 extracted AppImage checks.

Full CI qualification remains blocked. `scripts/check-release-qualification.mjs` compares actual suite hashes against the reviewed and executed real-input manifest. It exits 1 for nine legacy suites before CI can run their fabricated fixtures. No coverage percentage or green full CI result is claimed. Genuine malformed/domain-specific corpus, physical microphone and target compositor checks remain outstanding.

## Real workload

The stress check imports actual TypeScript implementation (9,112,572 bytes), TypeScript declarations (588,085 bytes), and repository README content. It queues 24 genuine file imports, edits with actual repository/declaration text, toggles layout and playback, seeks, verifies content hashes, and reopens the real persisted workspace. No generated document content or fake process is used.

The installed 1.0.0 baseline passed content preservation, but its nominal 90-second editing window completed only one cycle: 166,988 ms for that cycle and 177,198 ms total. Peak summed process-tree RSS was 6,352,261,120 bytes. Summed RSS can count shared pages more than once; it is not unique physical memory or a leak measurement. A cycle may overrun the requested minimum workload duration. This source-code workload is intentionally demanding and does not represent measured microphone or ordinary teleprompter-session performance.

Raw local measurements and distribution checksums are retained under `.release-local/evidence/` and `.release-local/1.0.1/`. Private input paths and the live-profile rollback archive are excluded from publication.

Confirmed installed 1.0.1 stress result: **1/1 workload passed**, four editing/layout/playback cycles in 354,288 ms. The import burst admitted 18 and refused six requests; 1.0.0 admitted all 24. Peak summed RSS was 7,755,272,192 bytes and maximum cycle latency was 173,099 ms. Content hashing and restart assertions passed. The workloads requested different minimum durations, so these results do not establish an improvement or regression in memory retention. Large-text editing remains a measured performance concern.

Public measurements are in [the release evidence directory](evidence/release-1.0.1/). Input mtimes were captured after the stress runs and are labeled accordingly; input hashes were captured inside each run. The source files are actual installed dependency files and repository documents.

## Performance diagnosis limits

The completed before/after stress measurements used Playwright trace recording. A separate spellcheck-disabled probe confirmed the setting on the current editor, but exceeded its 130-second budget; an earlier probe was discarded because selecting a document recreated the editor after the setting change. The untraced diagnostic also exceeded its 130-second budget during the prolonged editing stall. These observations do not establish a root cause or a memory leak. No speculative application change was made from them. The diagnostic probes are distinct from the completed content-preservation workload.

Immediate follow-up: capture a browser performance profile of large multiline insertion, separate native textarea work from renderer callbacks, and reproduce the same real input through a manual paste before changing the editor architecture. Keep this release classified as a prerelease while full corpus, coverage and device qualification remain open.

Confirmed installed runtime gate: **16 passed / 0 failed / 0 skipped / 0 flaky**, eight cases repeated twice with retries disabled. This matches the preceding unpacked implementation gate's 16/16 outcome. The checks exercised real import/save conflicts, renderer recovery budgets, pending editor close, empty content restart, mounted geometry, modal focus, actual filesystem permission failure, and genuine DOCX/PDF utility-process imports. `dpkg -V teleprompt` exited 0 with no differences. Runs used Xvfb; real microphone and desktop compositor behavior remain unverified.

Confirmed exact 1.0.1 extracted AppImage gate: **8 passed / 0 failed / 0 skipped / 0 flaky**, retries disabled, using the reviewed `AppRun`. The extraction and verifier exited 0. FUSE mounting itself was not exercised. Distribution names, byte sizes and SHA-256 hashes are in [artifacts.json](evidence/release-1.0.1/artifacts.json).
