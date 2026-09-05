# Implementation status — 2026-09-04

Subsequent 1.0.3 work is recorded in [RETENTION_HARDENING.md](RETENTION_HARDENING.md): startup symlink-root deletion fixed, diagnostic tests converted, reviewed subset expanded to 89 tests, and eight unreviewed suites remaining. The counts below preserve the earlier implementation checkpoint.

Baseline commit: `984b52b5acf2c5042a0dbe70b359d6f38dc6c981`. This records the implementation gate before the subsequent push/deploy/install instruction. See [RELEASE_1.0.1.md](RELEASE_1.0.1.md) for the later installation and stress qualification. Existing unrelated `.gitignore`, `.claude/`, `.ignore`, and `.mcp.json` changes were left alone.

## Confirmed implementation

| Area | Implemented behavior | Evidence |
| --- | --- | --- |
| Dependency/package boundary | DOMPurify 3.4.14, builder 26.15.3 and compatible lockfile fixes; packaged windows ignore inherited development URL. | `package.json`, `windows.ts:14`, current npm audit artifact and packaged tests with an unreachable development URL. |
| Content contract | Empty documents are valid; UTF-8 limits are checked before draft mutation; shipped seeded scripts removed. | `ipc.ts`, `workspace.ts`, real storage tests and packaged clear/reopen test. |
| Durable commands | Candidate workspace is adopted only after metadata succeeds; failed update restores prior draft; source-saved/metadata-failed is a typed partial outcome. | `app-store.ts:159`, `app-store.ts:247`, 12 actual-filesystem durability tests. |
| Recovery references | Unavailable references survive settings saves; draft cleanup validates primary and backup references. | `repositories.ts:103`, backup and unavailable-source tests. |
| Editor/close | One active update and one latest pending value; explicit conflict resolution; reload suspend/drain; editor flush then command/storage drain before close. Renderer unload guard also covers `window.close()`. | `EditorPane.tsx`, `index.ts:246`, packaged immediate quit and native-close tests. |
| Renderer lifecycle | Per-role recovery budget survives replacement, stops after three retries, and offers explicit native Retry. Destroyed-window cleanup is guarded. | `windows.ts`, packaged four-crash checks for both roles and native-close regression. |
| Playback/layout | Seek generations reject delayed checkpoints; geometry is tied to document/revision/mode and current mounted elements; banner uses horizontal distance. | `controller.ts`, `pacing.ts`, packaged seek/layout tests. |
| Parser admission | Bounded pending imports and cancellation; exact ZIP directory/local-header validation and streamed expansion preflight. | `import-service.ts`, `zip-policy.ts`, actual DOCX checks and utility-process tests. |
| Electron PDF runtime | Real graphics classes from existing canvas dependency and the real bundled PDF worker initialize inside the killable utility process. | `parser-core.ts`; genuine PDF failed with `DOMMatrix is not defined` before adapter, then passed packaged import. |
| UI recovery | Loading Controls appears before hydration; IPC waits for initialization; async action errors are visible; native modal traps focus. | `index.ts:117`, `Controls.tsx`, packaged permission failure and focus checks. |
| External save | Revalidates actual source hash and target identity after temporary-file fsync, immediately before rename. | `atomic-write.ts:57`; new real-file check moved from 4 pass / 1 fail to 5 pass / 0 fail across file-read/write suites. |

PDF dependency decision: `@napi-rs/canvas` 0.1.80 was already present transitively. Declaring it directly adds no new package version; it provides real DOMMatrix/ImageData/Path2D implementations. Its existing x64 native module is approximately 30 MiB. PDF.js 5.4.296 excludes Electron utility processes from its Node initialization (`node_modules/pdfjs-dist/legacy/build/pdf.mjs:6051`). The adapter does not falsify process identity or move parsing into the main process.

The existing renderers and preload consume the new checkpoint, bootstrap, and flush contracts together in the rebuilt artifact. Persistent schema remains v2. Live profiles were never migrated. Backup means latest available recovery bytes, not exact historical rollback.

## Verification and reassessment

The original audit had 2 passing / 6 failing focused expectations. Corresponding regression coverage now exercises empty IPC updates, stale seeks, fourth-crash stopping, backup draft retention, missing references, and failed metadata updates. The original audit collectors and their results are preserved as the before-change record; their crash collector intentionally expects the old behavior and is not the final gate.

Confirmed unit progression: first integrated real-input selection 57/57; adding real-file final-hash coverage exposed 1 failure in a 5-test file gate, then 5/5; expanded reviewed subset 80/80 across 19 suites. The machine-readable unit report and source hashes are in `evidence/implementation/`. Reports containing private local paths remain in the operator workspace; public release measurements are recorded separately. No legacy mock suite was run to obtain these counts.

Packaged reassessment caught two further implementation-boundary failures that unit success had missed: closing Controls accessed a destroyed BrowserWindow during cleanup, and real PDF import lacked DOMMatrix in Electron. A separate renderer-initiated-close probe then found pending UI text could be lost before native close interception; the unload guard addresses that path. Focused runtime checks passed after each correction. Combined/repeated runtime results are recorded separately; use their final status rather than interpreting this paragraph as a release sign-off.

Test environment: Node 26.7.0/npm 11.19.0 on this Linux host, Electron 43.1.1, Xvfb and the existing root-owned mode-4755 sandbox helper. No `--no-sandbox`, native ownership change, or live desktop fault injection was used. CI's Node 22.12 environment has not been rerun here.

## Remaining work, in execution order

1. **A0/A11 — finish real-input conversion and full coverage qualification.** Nine legacy test files still contain invented documents, fake workers/processes, or fabricated edge cases: diagnostic-log, documents/save-service, lifecycle/crash-retention, parser/parser-core, parser/supervisor, persistence/schema, presentation, shared/cues, and shared/text. Their assertions were preserved, not deleted to obtain a green subset. Real metadata/crash artifacts and repository documents can support further conversion; authentic malformed archives, structured subtitle/ODT/RTF files, cue-rich and large multilingual documents are still needed for remaining cases. `npm test` and the full coverage/release gate are not qualified.
2. **A6/A10 — extend fault and startup coverage.** The new UI catches command rejection and displays metadata errors. Active-first background restoration and last-successful-persistence timestamp are not implemented. Hydration remains sequential, although Controls now shows loading immediately. Exercise close cancellation/retry with slow real storage and simultaneous native close/quit; current happy close and EACCES checks do not prove every interleaving.
3. **A8 — qualify resource containment.** Actual DOCX/PDF import is covered. No authentic malformed/large corpus is available for full expansion/adversarial qualification. Streamed ZIP preflight does not establish a hard process RSS ceiling, and PDF/text extraction output is still accumulated before final length rejection. Measure a representative corpus before setting the planned RSS watchdog envelope.
4. **A9 — actual device and performance measurements.** Microphone start/edit/stop/revoke/device-loss paths need a real device/session. Caching and listener cleanup are implemented, but no CPU/RSS/long-task/latency improvement is claimed without comparable baseline and final measurements.
5. **A3/A11 — remaining platform/release gates.** Controlled crash budgets were exercised; unresponsive-event budget, explicit native Retry, long steady-state workload, installed deb behavior, and actual target compositor/global shortcuts still require qualification. AppImage/deb/tar generation alone is not installation validation. Review current distribution artifacts and hashes before any authorized publication.

Residual integrity limitations: rename has a final race window against another external writer; it is not portable compare-and-swap. V2 draft and metadata files are not a single crash-atomic transaction. Do not describe failed-rollback or post-rename filesystem failure as impossible. A revision-addressed schema or external-save backup design would need a separately reviewed compatibility decision.

## Reproduce the reviewed gate

Set `TELEPROMPT_REAL_DOCX` and `TELEPROMPT_REAL_PDF` to genuine local document paths. `scripts/test-real.mjs` refuses missing corpus inputs and names the unqualified legacy scope. Then run:

```bash
npm run typecheck
npm run test:real
npm run build
node_modules/.bin/electron-builder --linux --dir --config.directories.output=/tmp/teleprompt-implementation/release
node scripts/verify-artifact.mjs /tmp/teleprompt-implementation/release/linux-unpacked
```

For this host, the packaged runner uses `TELEPROMPT_E2E_EXECUTABLE=/tmp/teleprompt-implementation/release/linux-unpacked/teleprompt` and `CHROME_DEVEL_SANDBOX=/mnt/projects/teleprompt/release/linux-unpacked/chrome-sandbox`. Verify helper ownership/mode before reuse. Run `npm run test:e2e -- --retries=0`. The runner creates an isolated Xvfb display and exports the marker required by native clipboard tests; `xclip` must be installed. Use `--repeat-each=2` for the recorded repeated gate. All document modifications and crash probes target disposable profiles/copies.

Rollback: restore the reviewed source/lockfile slice and rebuild the previous artifact. Do not overwrite unrelated dirty files or reuse a test fault profile as a live profile. At this implementation checkpoint, no commit, push, deployment, native installation, or publication had been performed. The subsequent authorized installation is recorded in RELEASE_1.0.1.md.


## Final gate record and additional packaging finding

Confirmed combined runtime gate: **16 passed / 0 failed** (eight scenarios, two repeats, retries disabled), after the initial-import assertion was corrected and passed 3/3 independently. Unit gate: **80 passed / 0 failed** in 19 reviewed suites. Typecheck, build, and dependency audit succeeded. These are bounded checks, not full release qualification.

The generated builder 26.15.3 AppRun added `--no-sandbox` when `unshare -Ur true` failed. This was discovered by reading the actual extracted AppImage before executing its launcher. A project-owned `build/AppRun` now preserves sandbox requirements and avoids empty library-path components. `verify-artifact.mjs` rejects a launcher differing from the reviewed source. The original generated launcher failed this new check as expected. The final extracted-artifact check is recorded separately.

`test:e2e` and `test:soak` now package into fresh temporary directories and retain their review artifacts, so rerunning tests does not overwrite an existing configured sandbox helper. An explicitly supplied executable is verified and reused. An existing helper is reused only after checking root ownership and mode 4755; tests never modify native ownership or disable the sandbox.

KOS context was consulted with 80 referenced object ids and no missing references. It contained no accepted facts. Historical decisions `dec_c2546cf00175` and `dec_cd05593e1f93` describe the preceding audit/read-only stage; the user's subsequent implementation instruction superseded that stage's scope.

Final extracted AppImage gate: **8 passed / 0 failed**, retries disabled, through `npm run test:e2e` and the reviewed AppRun, using the existing sandbox helper. The extracted launcher exactly matched `build/AppRun`. AppImage/deb/tar artifacts were generated locally; paths, sizes and SHA-256 values are in `evidence/implementation/artifacts.json`. The deb control archive was inspected with `dpkg-deb --info`; the deb was not installed. FUSE mounting itself was not exercised. The earlier unpacked gate had **16 passed / 0 failed, 0 skipped, 0 flaky**.
