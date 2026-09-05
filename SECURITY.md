# Security policy

## Supported version

Security fixes target the current 1.x Linux x64 release line.

## Report a vulnerability

Use the repository's private GitHub security advisory flow. Include the affected version, threat scenario, reproduction, and whether exploitation requires a user-selected file or local machine access. Do not attach documents, drafts, crash dumps, or logs containing confidential script content without reviewing them first.

## Threat model

Teleprompt treats imported documents, persisted state, renderer content, dropped paths, and IPC payloads as untrusted. The main assets are script confidentiality, existing recovery-draft integrity, source-file integrity, and availability during a live presentation.

The controls renderer has explicit document/settings authority. The transparent overlay is considered more exposed because it is always on top and interactive, so it receives a smaller capability set. Local users with access to the same account and operating-system-level compromise are outside the application boundary.

## Controls

- Sandboxed, context-isolated renderers with Node integration disabled.
- Separate typed preloads for controls and overlay; no generic IPC bridge.
- Exact channel, role, top-frame, and renderer-origin authorization in the main process.
- Navigation, popups, and webviews denied; restrictive renderer CSP; Markdown sanitized with DOMPurify.
- Private custom production protocol and ASAR-only loading. The integrity fuse is set, but Electron does not support embedded ASAR integrity enforcement on Linux; installation permissions and independently verified distribution hashes remain necessary. See [Electron ASAR integrity support](https://www.electronjs.org/docs/latest/tutorial/asar-integrity).
- Node execution, `NODE_OPTIONS`, Node inspector CLI arguments, and privileged `file://` behavior disabled through Electron fuses.
- Regular-file-only, symlink-refusing, nonblocking, bounded reads.
- Concurrency, input, output, timeout, ZIP entry, expansion, and compression-ratio limits for document parsing in a killable utility process. The concurrency slot remains held until actual exit. A 50 ms RSS watchdog kills a parser observed above 512 MiB; PDF output is checked page by page.
- No document editing, source-save IPC, or source-write service. Metadata and exported preferences use temporary-file writes, fsync, target revalidation, and atomic rename.
- Private state/draft permissions, strict versioned parsing, backup recovery, and quarantine for invalid state.
- Fail-fast main-process error policy and bounded renderer recovery with backoff.
- Secret-like environment variables scrubbed before local Crashpad startup; no crash upload; bounded crash retention and redacted logs.
- Linux crash cleanup pins directory descriptors and refuses symlink traversal, including concurrent replacement of directory paths.
- All microphone and device permission requests denied.

## Data and privacy

Document contents are held in memory while open. Existing recovery drafts from older versions remain readable and are never deleted by this release. Controls receive a content-free workspace snapshot. The overlay receives a smaller rendering projection with no source/recent paths, hotkeys, or unrelated document metadata. Only the active document body is sent separately to the two trusted application surfaces.

There is no microphone capture or voice recognition. The permission check and request handlers both deny access.

## Residual risks

- Release artifacts are not code-signed and there is no in-app updater; verify SHA-256 checksums from the release workflow.
- The RSS watchdog is sampled, so allocations can overshoot its threshold. It is not a kernel memory ceiling. Large accepted files can still require substantial renderer memory.
- Directory-descriptor cleanup prevents path redirection; it does not provide inode-conditional deletion if another process replaces a file inside the same held directory. Atomic metadata rename likewise is not portable compare-and-swap with another writer.
- X11 global shortcuts and `xdotool` deliberately affect desktop-global input when armed.
- Linux does not provide Electron content-protection support; do not rely on Teleprompt to keep the overlay out of recordings.
- Complex document parsing libraries remain a supply-chain and parser-risk surface despite isolation and limits. Keep dependencies current and rerun audit, parser fixtures, and packaged tests for each release.
