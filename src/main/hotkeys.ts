import { globalShortcut } from 'electron'
import { parseCues } from '../shared/cues.js'
import { DEFAULT_HOTKEYS, type HotkeyCommand } from '../shared/types.js'
import type { AppStore } from './application/app-store.js'
import type { AppController } from './application/controller.js'
import { sendDeckKey } from './presentation.js'
import {
  applyOverlayEffects,
  broadcastActiveDocument,
  broadcastSnapshot,
  setOverlayVisible,
} from './windows.js'

const CLICKER_BINDINGS = ['PageDown', 'PageUp'] as const

export class HotkeyManager {
  private clickerActive = false
  private readonly failedAccelerators = new Set<string>()

  constructor(
    private readonly store: AppStore,
    private readonly controller: AppController,
  ) {}

  getStatus(): { failed: string[] } {
    return { failed: [...this.failedAccelerators] }
  }

  register(): void {
    globalShortcut.unregisterAll()
    this.failedAccelerators.clear()
    this.clickerActive = false
    const bindings = { ...DEFAULT_HOTKEYS, ...this.store.getSnapshot().hotkeyBindings }
    for (const command of Object.keys(bindings) as HotkeyCommand[]) {
      const accelerator = bindings[command]
      if (accelerator) this.tryRegister(accelerator, () => this.handle(command))
    }
    for (let index = 1; index <= 9; index += 1) {
      this.tryRegister(`CommandOrControl+Alt+${index}`, () => this.jumpToCue(index - 1))
    }
    this.setClickerArmed(this.store.getSnapshot().clickerMode)
  }

  rebind(bindings: Record<HotkeyCommand, string>): void {
    this.store.patchState({ hotkeyBindings: { ...bindings } })
    this.register()
    this.publish(false)
  }

  unregister(): void {
    globalShortcut.unregisterAll()
    this.failedAccelerators.clear()
    this.clickerActive = false
  }

  setClickerArmed(enabled: boolean): void {
    if (enabled === this.clickerActive) {
      this.store.patchState({ clickerMode: enabled })
      return
    }
    if (enabled) {
      this.tryRegister('PageDown', () => this.stepScroll(1))
      this.tryRegister('PageUp', () => this.stepScroll(-1))
    } else {
      for (const accelerator of CLICKER_BINDINGS) {
        globalShortcut.unregister(accelerator)
        this.failedAccelerators.delete(accelerator)
      }
    }
    this.clickerActive = enabled
    this.store.patchState({ clickerMode: enabled })
    this.publish(false)
  }

  private tryRegister(accelerator: string, callback: () => void): void {
    if (!accelerator) {
      this.failedAccelerators.add('(empty)')
      return
    }
    try {
      if (globalShortcut.register(accelerator, callback)) this.failedAccelerators.delete(accelerator)
      else this.failedAccelerators.add(accelerator)
    } catch {
      this.failedAccelerators.add(accelerator)
    }
  }

  private handle(command: HotkeyCommand): void {
    const snapshot = this.store.getSnapshot()
    switch (command) {
      case 'play-pause':
        this.controller.togglePlayback()
        break
      case 'speed-up':
        this.store.patchState({ scrollSpeed: Math.min(400, snapshot.scrollSpeed + 10) })
        break
      case 'speed-down':
        this.store.patchState({ scrollSpeed: Math.max(5, snapshot.scrollSpeed - 10) })
        break
      case 'opacity-up':
        this.store.patchState({ opacity: Math.min(1, +(snapshot.opacity + 0.05).toFixed(2)) })
        break
      case 'opacity-down':
        this.store.patchState({ opacity: Math.max(0.05, +(snapshot.opacity - 0.05).toFixed(2)) })
        break
      case 'next-file':
      case 'prev-file': {
        if (snapshot.documents.length === 0) return
        const current = snapshot.documents.findIndex(
          (document) => document.id === snapshot.activeDocumentId,
        )
        const direction = command === 'next-file' ? 1 : -1
        const index =
          (Math.max(0, current) + direction + snapshot.documents.length) % snapshot.documents.length
        this.controller.selectDocument(snapshot.documents[index].id)
        break
      }
      case 'toggle-overlay': {
        const visible = !snapshot.overlayVisible
        this.store.patchState({ overlayVisible: visible })
        setOverlayVisible(visible)
        break
      }
      case 'toggle-click-through':
        this.store.patchState({ clickThrough: !snapshot.clickThrough })
        break
      case 'restart':
        this.controller.restart()
        break
    }
    this.publish(true)
  }

  private stepScroll(direction: 1 | -1): void {
    const snapshot = this.store.getSnapshot()
    this.controller.seek(snapshot.scrollPosition + direction * snapshot.clickerStep)
    if (snapshot.drivePresentation) void sendDeckKey(direction === 1 ? 'advance' : 'back')
    this.publish(false)
  }

  private jumpToCue(index: number): void {
    const document = this.store.getActiveDocument()
    const cue = document ? parseCues(document.content)[index] : undefined
    if (!cue) return
    this.controller.seek(cue.position)
    this.publish(false)
  }

  private publish(includeDocument: boolean): void {
    applyOverlayEffects()
    broadcastSnapshot(this.store.getSnapshot())
    if (includeDocument) {
      const document = this.store.getActiveDocument()
      broadcastActiveDocument(
        document ? { id: document.id, revision: document.revision, content: document.content } : null,
      )
    }
  }
}
