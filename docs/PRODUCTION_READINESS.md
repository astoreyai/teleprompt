# Linux x64 release qualification — 1.1.1

Qualification date: 2026-10-28. Teleprompt is a native Linux application; Docker is not required. Version 1.1.1 remains a prerelease pending native installation and target-desktop acceptance.

## Changes

Preference imports now apply pacing and overlay window changes through the same path as individual controls. Preference updates return the final calculated snapshot. Capability initialization failures appear in the existing alert surface. Electron, DOMPurify, Vite, Vitest, and vulnerable transitive dependencies were updated. Native tests isolate their display, D-Bus session, and runtime directory.

## Executed evidence

- Configured baseline and final unit gates: 31 suites / 116 tests passed. Type checking and production build passed.
- Coverage: statements 86.71%, branches 82.69%, functions 87.23%, lines 92.46%. These thresholds cover the configured core modules, not the entire application.
- Dependency audit: zero reported vulnerabilities after updates; the initial audit reported 10.
- Three-repeat packaged suite: 65 cases passed immediately; one startup assertion observed `interactive` instead of `complete` and passed on retry. The test now waits for the actual load event before injecting a renderer hang. The corrected recovery case passed three repetitions with retries disabled (exit 0).
- Five-minute real-file workload: 188 iterations in 301.721 seconds; source bytes unchanged and selection/settings restored after restart. Selection latency median 29.75 ms, p95 403.84 ms. Peak process-tree PSS 1.58 GiB. This workload includes large installed TypeScript files and repository documents; it is not a hardware-independent performance guarantee.
- AppImage, Debian, and tar.gz build; executable fuse/layout verification; package version check; and distribution SHA-256 checks passed.
- The preceding candidate passed 66/66 soak cases and three smoke cases for each extracted distribution format. Those earlier results are supplementary, not a substitute for current-version evidence.

The release includes `VERIFICATION.json`, `STRESS.json`, and `SHA256SUMS.txt`. Local raw logs and artifacts remain under `.release-local/v1.1.1`. Native crash artifacts remain local and are not release assets.

## Release boundary

Clean supported-distribution installation/uninstallation and a second-distribution run remain unverified. Extracted package execution does not verify package-manager hooks. Actual compositor global shortcuts, above-fullscreen behavior, and presentation driving require native desktop acceptance. Unsigned artifacts and no auto-updater remain documented limitations.

Rollback: reinstall the previous v1.1.0 package and preserve the existing private user-data directory. The v2 metadata format is unchanged. Source documents remain read-only.
