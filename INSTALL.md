# Install — Linux

Teleprompt is distributed for Linux x64 only. Three formats are produced:

| Format | When to use it |
| --- | --- |
| **AppImage** | Any Linux distro. Single file, no install required. Just `chmod +x` and run. |
| **.deb** | Debian / Ubuntu / Pop!_OS / Mint — system-integrated install with menu entry, file associations, dependencies pinned. |
| **tar.gz** | Manual install / extract anywhere — useful for sandboxed environments. |

Pre-built binaries land in `release/` after `npm run package`.

---

## AppImage (recommended)

```bash
chmod +x Teleprompt-0.1.0-x64.AppImage
./Teleprompt-0.1.0-x64.AppImage
```

To integrate with your menus/launchers, install [`AppImageLauncher`](https://github.com/TheAssassin/AppImageLauncher).

If the AppImage refuses to start, run with `--appimage-extract-and-run` once to bypass FUSE:

```bash
./Teleprompt-0.1.0-x64.AppImage --appimage-extract-and-run
```

## .deb

```bash
sudo apt install ./teleprompt_0.1.0_amd64.deb
teleprompt
```

Uninstall: `sudo apt remove teleprompt`.

## tar.gz

```bash
tar -xzf Teleprompt-0.1.0.tar.gz
cd Teleprompt-0.1.0
./teleprompt
```

---

## Optional system dependencies

| Package | Purpose | Required? |
| --- | --- | --- |
| `xdotool` | Drives external presentations (PowerPoint/Impress/Evince fullscreen). Sends Right/Left arrow to focused window when **Drive presentation** is enabled. | Optional. Install for slide-control: `sudo apt install xdotool` |
| `evince` | Default PDF viewer — cooperates with overlay's always-on-top mode. | Optional. Install if you do PDF presentations: `sudo apt install evince` |
| `libnotify4`, `libgtk-3-0`, `libnss3`, `libxss1`, `libxtst6`, `xdg-utils`, `libatspi2.0-0`, `libdrm2`, `libgbm1`, `libxcb-dri3-0` | Electron runtime dependencies. | Auto-installed by .deb. |

The .deb declares all required deps. AppImage and tar.gz bundle most but require system Electron prerequisites — usually present on any modern desktop distro.

---

## Display server notes

- **X11**: full feature support — always-on-top, global hotkeys, screen-capture hiding, presentation drive (xdotool), drag/resize.
- **Wayland**: limited. The Controls window shows a banner. `setContentProtection`, global hotkeys, and xdotool-based presentation drive are no-ops or unreliable on most Wayland compositors. **XWayland** is the most predictable fallback — start the AppImage with `GDK_BACKEND=x11 ./Teleprompt-...AppImage`.

---

## Building from source

```bash
git clone https://github.com/astoreyai/teleprompt.git
cd teleprompt
npm install
npm run package        # all three Linux formats
npm run package:appimage   # AppImage only
npm run package:deb        # .deb only
```

Build artifacts land in `release/`. Build takes ~30 s after the first run; first-time downloads the Electron 41 binary (~120 MB).

---

## First-launch checklist

1. Open the Controls window.
2. Click an entry in the **Examples** sidebar to load a sample script (no real file needed).
3. Press **▶** to start scrolling.
4. Set a **Pacing target** (Duration, e.g. `5:00`, or **Target WPM**) — speed adjusts automatically.
5. Optional toggles in **Overlay behavior**:
   - **Stay above fullscreen apps** — for slideshow workflows.
   - **Click-through** — read-while-doing-other-things mode; top edge stays grabbable.

For PDF workflows: open the PDF in **Evince** (`F11` for fullscreen), enable **Drive presentation** + **Listen for clicker** in Controls. Your clicker advances both the prompter and the PDF.

---

## Uninstall / reset

- AppImage: just delete the file.
- .deb: `sudo apt remove teleprompt`.
- All: settings + recent files persist at `~/.config/Teleprompt/`. Delete that directory for a clean slate, or use **Settings → Reset to defaults** in-app.
