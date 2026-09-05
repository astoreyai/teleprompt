# Native crash corpus qualification

Baseline: `57458f23f7936fe9803fa596b42bead7eb1066bf`, installed Teleprompt 1.0.3. The reviewed gate passed **89 tests**, with zero failures or pending cases. The release qualification guard reported eight unreviewed suites. Input hashes and observed modification times were recorded before editing.

## Confirmed conversion

The installed Controls recovery-budget test loaded the repository README, crashed four actual renderer processes through CDP `Page.crash`, verified recovery exhaustion, and shut down the application. It passed and produced genuine Crashpad `.dmp` and `.meta` files. The test now retains byte-for-byte copies under its local `crash-corpus` output directory, along with artifact hashes, sizes, source modification times, capture time, application archive hash, and input hash. The directory is created with mode 0700. No process-memory artifacts are committed or uploaded.

`src/main/lifecycle/crash-retention.test.ts` now consumes that corpus through `TELEPROMPT_REAL_CRASH_CORPUS`. It checks selected artifact bytes against capture hashes before copying them into disposable directories. The old fabricated dump strings and manufactured file dates were removed. All previous behavior assertions remain: age expiry removes dumps and sidecars, unrelated bytes survive, the newest artifact wins a count limit, and a missing directory is tolerated. A new case checks preservation of fresh dump/metadata bytes under the default policy.

Age expiry uses actual elapsed wall time with a zero-age retention policy. This exercises the expiry branch without pretending to have observed seven days of aging. Ordering uses sequential copies and their actual filesystem modification times. It fails if the filesystem cannot distinguish those times. These tests do not establish atomic protection against concurrent directory replacement.

The focused retention gate passed **7/7** tests. The reviewed gate increased to **92/92 tests in 22 suites**, with zero failures or pending cases. Only the reviewed and executed crash-retention source hash was added to the qualification manifest. Seven suites remain unreviewed: save-service, parser-core, parser/supervisor, persistence/schema, presentation, shared/cues, and shared/text. Their fabricated cases were not run or certified.

## Execute with real inputs

Set `TELEPROMPT_REAL_DOCX` and `TELEPROMPT_REAL_PDF` to existing genuine documents. Keep private document paths and crash output out of commits and uploads. Then capture a fresh corpus:

```bash
npm run test:e2e -- --grep 'packaged controls recovery stops' --retries=0
```

That command builds and verifies a package unless `TELEPROMPT_E2E_EXECUTABLE` already selects an installed or packaged executable. The selected process must support Crashpad capture. A successful recovery test with missing artifacts fails the corpus assertions rather than inventing replacements.

Run the reviewed units against the captured output:

```bash
python3 - <<'PY'
import os
from pathlib import Path
import subprocess

corpora = list(Path('test-results').glob('*/crash-corpus/provenance.json'))
if len(corpora) != 1:
    raise SystemExit('Expected one newly captured corpus; select an explicit TELEPROMPT_REAL_CRASH_CORPUS if using another output directory')
os.environ['TELEPROMPT_REAL_CRASH_CORPUS'] = str(corpora[0].parent.resolve())
raise SystemExit(subprocess.call(['npm', 'run', 'test:real']))
PY
```

For an explicitly selected corpus, export `TELEPROMPT_REAL_CRASH_CORPUS` and run `npm run test:real` directly. The selector refuses missing DOCX, PDF, or crash inputs. It records native artifact provenance alongside the existing real document inputs when `TELEPROMPT_TEST_EVIDENCE` is set. Full coverage remains blocked by the seven unreviewed suites; obtaining a crash corpus does not qualify them or supply a publishable DOCX/PDF corpus to CI.

## Next implementation order

1. Obtain genuine ODT/RTF/subtitle, malformed parser, legacy persistence, multilingual, and cue-bearing inputs for the remaining cases. Convert and execute each suite before certifying its source hash. Use actual native processes for supervisor/presentation boundaries.
2. Reproduce and close the concurrent directory-replacement race before claiming atomic cleanup containment.
3. Resolve the Undo-history policy before changing editor history; compare any memory change using the established real-document workload.

This slice changes verification and documentation only. Production source, package version, installed runtime, schema v2, and Undo behavior remain unchanged. Rollback is reverting the test/documentation commit. KOS context checked 86 object ids with zero missing and no accepted facts or conflicts. Historical audit-only decisions `dec_cd05593e1f93` and `dec_c2546cf00175` are superseded by the user's implementation and push authorization.

## Final runtime verification

Confirmed: the installed 1.0.3 runtime gate remained **22/22 passing** versus the previous 22/22 checkpoint, with two repeats, zero retries, and zero failed, skipped, or flaky cases. Four fresh native corpora each contained eight artifacts; their copied hashes, recorded application archive hash, and directory mode 0700 were checked. The reviewed units were then rerun against one of those fresh captures: **92/92 passed**. Typecheck passed. Removing the crash-corpus environment variable caused the selector to exit 2 before Vitest. [Recorded gate evidence](evidence/crash-corpus-qualification.json) contains counts and public hashes; raw dumps and private document paths remain local.
