# Contributing

Teleprompt uses a test-driven reliability loop. Use Node.js 22.12 or newer and install the locked dependency graph with `npm ci`.

## Red → green → refactor

1. Write the smallest regression test that reproduces the failure at the lowest useful boundary.
2. Run that test and confirm it fails for the intended reason.
3. Make the smallest architectural change that restores the invariant.
4. Run the focused test, then the full unit and coverage suite.
5. Refactor only while the suite stays green.
6. For process, preload, persistence, lifecycle, or packaging changes, run the packaged E2E test.

```bash
npm run test:watch
npm run typecheck
npm run test:coverage
npm run test:e2e
```

Tests belong beside the boundary they protect:

- domain and application tests cover stable IDs, revisions, persistence ordering, and transient-state reset;
- file tests cover bounded reads, archive policy, conflict checks, and atomic writes;
- lifecycle tests cover bounded backoff, renderer recreation, and crash retention;
- renderer tests cover pure pacing/checkpoint logic and accessibility-facing behavior;
- packaged Playwright tests cover the real fused executable and cross-process contracts.

## Architectural rules

- The main process owns authoritative state and filesystem authority.
- `AppSnapshot` must remain free of document bodies.
- Send active content separately and only when selection or revision changes.
- Identify every document command by stable ID and expected revision.
- Persist a draft before acknowledging an edit; persist its metadata reference before returning.
- Never overwrite a lossy import format. Use Save As.
- Route every document path through `DocumentImportService`.
- Keep parsers bounded and outside the main process.
- Add IPC channels to the typed role API and the authorization manifest together.
- Do not expose Electron or generic `send`/`invoke` primitives to a renderer.
- Treat renderer termination as recoverable, bounded, and idempotent; treat uncaught main-process failures as fatal after a best-effort flush.

## Required gates

```bash
npm run check
npm run check:release
npm run test:soak
npm run package
```

Linux packaged tests require `xvfb-run`. The scripts disable core dumps because the recovery test intentionally crashes a renderer.

To run the same process-boundary suite against an installed package instead of `release/linux-unpacked`, set the executable explicitly:

```bash
TELEPROMPT_E2E_EXECUTABLE=/opt/Teleprompt/teleprompt \
  xvfb-run -a sh -c 'ulimit -c 0; npx playwright test'
```
