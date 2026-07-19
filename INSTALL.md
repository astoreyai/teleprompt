# Install Teleprompt on Linux

Teleprompt 1.0 ships for Linux x64 in three formats. Release artifacts are unsigned; verify the published `SHA256SUMS.txt` before running them.

| Format | Use case |
| --- | --- |
| AppImage | Portable desktop use without a system install |
| deb | Debian, Ubuntu, Pop!_OS, or Mint integration |
| tar.gz | Manual extraction or controlled deployment |

## Verify a release

Keep the artifacts and checksum file in the same directory, then run:

```bash
sha256sum --check SHA256SUMS.txt
```

Every listed artifact must report `OK`. Do not install a package from a bundle with a missing or failed checksum.

## AppImage

```bash
chmod +x Teleprompt-1.0.0-x86_64.AppImage
./Teleprompt-1.0.0-x86_64.AppImage
```

If FUSE is unavailable:

```bash
./Teleprompt-1.0.0-x86_64.AppImage --appimage-extract-and-run
```

## Debian package

```bash
sudo apt install ./teleprompt_1.0.0_amd64.deb
teleprompt
```

To replace an existing installation with the same build, use:

```bash
sudo apt install --reinstall ./teleprompt_1.0.0_amd64.deb
```

Confirm the installed package and verify its managed files:

```bash
dpkg-query -W -f='${Status}\n${Package} ${Version} ${Architecture}\n' teleprompt
sudo dpkg -V teleprompt
```

No output from `dpkg -V` means the package-managed files match their recorded metadata. Remove the program with `sudo apt remove teleprompt`; its per-user workspace and recovery drafts remain available for a later reinstall.

### Upgrade and rollback

Close Teleprompt before replacing the package. A 0.1.x workspace is migrated on first 1.0 launch while the legacy metadata remains available. Back up `~/.config/teleprompt/` before a major upgrade if it contains irreplaceable drafts.

Downgrading after 1.0 has written schema-v2 state is not supported. Restore a pre-upgrade user-data backup if an application rollback is required.

## Tar archive

```bash
tar -xzf teleprompt-1.0.0.tar.gz
./teleprompt-1.0.0/teleprompt
```

Confirm the exact directory name with `tar -tzf teleprompt-1.0.0.tar.gz | head` because archive naming can vary by builder version.

## Build from source

Requirements are Node.js 22.12 or newer, npm, and standard Linux Electron build libraries.

```bash
git clone https://github.com/astoreyai/teleprompt.git
cd teleprompt
npm ci
npm run check:release
npm run package
```

Artifacts are written to `release/`. To build one format, use `npm run package:appimage` or `npm run package:deb`.

The packaged E2E suite can also validate an installed or manually extracted binary:

```bash
TELEPROMPT_E2E_EXECUTABLE=/opt/Teleprompt/teleprompt \
  xvfb-run -a sh -c 'ulimit -c 0; npx playwright test'
```

## Optional integration

Install `xdotool` only if Teleprompt should send left/right keys to a focused X11 presentation application:

```bash
sudo apt install xdotool
```

Presentation driving is unavailable on Wayland. Screen-capture protection is unavailable on Linux. Global shortcuts and always-on-top behavior depend on the compositor.

## Data and recovery

The About panel shows the exact state path. On a typical Linux installation it is under `~/.config/teleprompt/` and contains:

- versioned workspace metadata and one backup;
- private recovery drafts for dirty documents;
- quarantined invalid state, if recovery was needed;
- a bounded local diagnostic log under the Electron logs directory.

Reset preferences in the app to preserve documents and drafts. For a complete reset, close Teleprompt first, move its user-data directory to a backup location, then relaunch. Moving it is preferable to deleting it until recovery drafts have been inspected.

## Crash troubleshooting

1. Leave hardware acceleration disabled (the default).
2. Run the unpacked binary from a terminal and capture its exit code.
3. Inspect `teleprompt-crash.log` in the Electron logs directory; the file is private, redacted, rotated at 512 KiB, and safe to attach after review.
4. Preserve recovery drafts before removing user data.
5. Report the Teleprompt version, Linux distribution, display server, reproduction steps, and whether the controls or overlay window disappeared.

To opt into GPU acceleration for a validated machine:

```bash
TELEPROMPT_HWACCEL=1 teleprompt
```
