# Crash cleanup and real-input qualification — 1.0.3

Baseline source: `4aedd8abc291f894515ea570a68cd70fa986ceae`, installed Teleprompt 1.0.2. The starting reviewed gate passed 80/80 tests; full qualification exited 1 for nine unreviewed suites. Unrelated configuration changes and private local artifacts were left outside this change.

## Confirmed startup deletion

`bootstrap()` passes `app.getPath('crashDumps')` to `purgeOldCrashArtifacts()`. Cleanup previously enumerated the supplied root directly. Nested directory symlinks were skipped by the directory-entry filter, but the supplied root had no equivalent check.

With the real Crashpad path symlinked into a disposable folder containing 11 unmodified JSON files from this repository, default cleanup deleted one unrelated report to enforce its ten-file limit. The inputs were the nine recorded performance reports plus `package.json` and `package-lock.json`; they were actual documents used to test filesystem safety, not manufactured minidumps.

Confirmed twice through different execution paths: the direct filesystem regression failed, and the installed 1.0.2 application's real startup removed a report before Controls loaded. An initial runtime probe incorrectly read a nonexistent `name` field on `DocumentContent`; that assertion was corrected to compare the real README content before recording the installed failure. The invalid probe is excluded from the diagnosis.

Cleanup now checks each directory with `lstat` and refuses directory links before enumeration. Existing ordinary-directory retention, missing-directory tolerance, and nested-link refusal remain exercised. The focused group moved from **8 passing / 1 failing** to **9 passing / 0 failing**. The rebuilt package passed **22/22 runtime cases**, including the startup regression twice, with retries disabled.

This is a fix for the reproduced root-link redirect. It is not an atomic filesystem traversal: a directory could still be replaced between inspection and enumeration. Closing that race requires a separate implementation and real concurrent-filesystem qualification. Crashpad itself still receives its existing directory path and can create its own files there; this change guards Teleprompt's cleanup. No IPC, persistent schema, document format, or Undo-history policy changes.

## Real diagnostic input and qualification

The fabricated diagnostic inputs were replaced with a verbatim line captured from the public [GitHub verification run](https://github.com/astoreyai/teleprompt/actions/runs/33928836003). GitHub had already masked its credential value before publication. The fixture contains the genuine published `token: ***` field; no live credential was read into the test or stored in the repository.

The [fixture](../../../test/fixtures/github-checkout-token.log) and [provenance](../../../test/fixtures/github-checkout-token.provenance.json) record the original source commit, capture time, byte count, checksum, and exact selection method. Five tests exercise redaction of that published field, rotation of an actual preceding log, destination and backup symlinks to real documents, file permissions, and an actual directory occupying the destination. This does not qualify every possible raw-secret syntax.

The reviewed subset now passes **89/89 tests in 21 files**. The manifest adds only source hashes of the two reviewed and executed suites. Full qualification remains blocked by **eight** suites: documents/save-service, lifecycle/crash-retention, parser/parser-core, parser/supervisor, persistence/schema, presentation, shared/cues, and shared/text. The original crash-artifact suite remains unqualified: the new filesystem-safety tests do not claim authentic `.dmp` or `.meta` corpus coverage. No remaining fabricated suite was run or certified.

The public log fixture is explicitly tracked despite the general `*.log` ignore rule. Other local logs, private DOCX/PDF paths, test profiles, and full traces remain excluded. CI still needs publishable genuine DOCX/PDF inputs and the remaining domain/malformed corpus before complete coverage qualification can pass.

## Remaining execution order

1. Obtain the genuine inputs required by the eight remaining suites, convert their cases without fabricated data or process doubles, run them, and certify only reviewed executed source hashes. Configure publishable DOCX/PDF inputs for CI.
2. Rework crash-cleanup traversal to retain directory identity during concurrent filesystem replacement, then reproduce and test the real race before claiming complete containment.
3. Resolve the Undo-history policy and measure the chosen behavior using the established real-document workload. The 1.0.2 memory results remain the current performance evidence; this release adds no claimed memory improvement.

KOS context was checked with 81 referenced objects and zero missing ids; it contained no accepted facts. Historical audit-scope decisions `dec_c2546cf00175` and `dec_cd05593e1f93` remain superseded by the user's implementation and deployment instructions.


## Installation and final gates

Confirmed: the package manager upgraded only Teleprompt from 1.0.2 to 1.0.3. The installed, built, and extracted AppImage archives all have SHA-256 `fb906c12941a6c0ee377fd6da774f4196b677b62f877c1ece0c23225450ac42e`. `dpkg -V teleprompt` and the artifact verifier exited 0. The extracted AppRun matched the reviewed source. The package continued to skip its unsupported AppArmor profile on this host; no sandbox-disable flag was added.

Final gates: **89/89 reviewed unit tests**, **22/22 packaged runtime cases**, **22/22 installed runtime cases**, and **11/11 extracted AppImage cases**. Runtime retries were disabled; no failures, skips, or flaky cases were reported. A short installed native-paste stress run completed **10 cycles**, passed content/restart checks, and identified the same installed archive hash. This was a smoke run, not a new five-minute performance comparison. Typecheck and dependency audit passed; the latter reported zero vulnerabilities.

The local `test`, `test:watch`, and `test:coverage` entry points now enforce the same qualification guard as CI. Each was executed and stopped with exit 1 at the eight-suite guard before Vitest could run. The explicit reviewed selector still passes 89/89. Packaged metadata was inspected to confirm that these development scripts are excluded; the packaged main bundle and runtime metadata match the current build/source.

[Verification](evidence/retention-1.0.3/verification.json), [local guard results](evidence/retention-1.0.3/local-qualification-guards.json), and [distribution checksums](evidence/retention-1.0.3/artifacts.json) preserve the evidence. Full qualification is still blocked, so this remains a prerelease. Physical compositor/microphone behavior and FUSE mounting were not exercised.

Rollback: close Teleprompt and reinstall the checksum-verified 1.0.2 Debian package retained under `.release-local/1.0.2/`. That restores the previous application behavior, including its cleanup defect. Revert the 1.0.3 release commit to undo source changes. The schema remains v2, and all deletion probes operated on disposable copies rather than the live profile.
