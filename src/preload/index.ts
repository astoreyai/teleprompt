import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppSnapshot, DocumentContent, DocumentFormat, DocumentId, OverlaySnapshot } from '../shared/contracts.js'
import type { ControlsApi, OverlayApi, PreferencePatch } from '../shared/ipc.js'
import type { HotkeyCommand } from '../shared/types.js'

const surface = process.argv
  .find((argument) => argument.startsWith('--teleprompt-surface='))
  ?.split('=')[1]

const on = <T>(channel: string, callback: (payload: T) => void): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

if (surface === 'controls') {
  const api: ControlsApi = {
    onFlushRequest: (callback) => on<string>('editor:flush', callback),
    acknowledgeFlush: (requestId, ok) => ipcRenderer.invoke('editor:flushed', { requestId, ok }),
    onStorageIssues: (callback) => on<string[]>('storage:issues', callback),
    onClosingChanged: (callback) => on<boolean>('app:closing', callback),
    onUnresolvedDocuments: (callback) => on('recovery:changed', callback),
    bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
    openFiles: () => ipcRenderer.invoke('documents:open'),
    openRecent: (path) => ipcRenderer.invoke('documents:openRecent', { path }),
    openDroppedFile: (file) => {
      const path = webUtils.getPathForFile(file)
      if (!path) return Promise.resolve({ ok: false, error: 'dropped file has no local path' })
      return ipcRenderer.invoke('documents:openDropped', { path })
    },
    createDocument: (name, content, format) =>
      ipcRenderer.invoke('documents:create', { name, content, format }),
    selectDocument: (id) => ipcRenderer.invoke('documents:select', { id }),
    removeDocument: (id, discardDirty) =>
      ipcRenderer.invoke('documents:remove', { id, discardDirty }),
    updateDocument: (id, expectedRevision, content) =>
      ipcRenderer.invoke('documents:update', { id, expectedRevision, content }),
    saveDocument: (id, saveAs = false) => ipcRenderer.invoke('documents:save', { id, saveAs }),
    reloadDocument: (id, discardDirty) =>
      ipcRenderer.invoke('documents:reload', { id, discardDirty }),
    togglePlayback: () => ipcRenderer.invoke('playback:toggle'),
    restartPlayback: () => ipcRenderer.invoke('playback:restart'),
    seek: (position) => ipcRenderer.invoke('playback:seek', position),
    updatePreferences: (patch: PreferencePatch) => ipcRenderer.invoke('preferences:update', patch),
    setOverlayVisible: (visible) => ipcRenderer.invoke('overlay:setVisible', visible),
    requestVoice: (enabled) => ipcRenderer.invoke('voice:request', enabled),
    grantVoiceConsent: () => ipcRenderer.invoke('voice:grantConsent'),
    revokeVoiceConsent: () => ipcRenderer.invoke('voice:revokeConsent'),
    reportVoiceStatus: (status, error) => ipcRenderer.invoke('voice:status', { status, error }),
    setClickerArmed: (enabled) => ipcRenderer.invoke('clicker:setArmed', enabled),
    setPresentationArmed: (enabled) =>
      ipcRenderer.invoke('presentation:setArmed', enabled),
    updateHotkeys: (bindings: Record<HotkeyCommand, string>) =>
      ipcRenderer.invoke('hotkeys:update', bindings),
    getHotkeyStatus: () => ipcRenderer.invoke('hotkeys:status'),
    getPlatformInfo: () => ipcRenderer.invoke('platform:info'),
    getPresentationStatus: () => ipcRenderer.invoke('presentation:status'),
    resetPreferences: () => ipcRenderer.invoke('preferences:reset'),
    clearRecentFiles: () => ipcRenderer.invoke('preferences:clearRecent'),
    exportPreferences: () => ipcRenderer.invoke('preferences:export'),
    importPreferences: () => ipcRenderer.invoke('preferences:import'),
    getAbout: () => ipcRenderer.invoke('preferences:about'),
    onSnapshot: (callback) => on<AppSnapshot>('snapshot:changed', callback),
    onActiveDocument: (callback) => on<DocumentContent | null>('document:changed', callback),
    onProgress: (callback) => on<number>('playback:progress', callback),
    onOverlayGeometry: (callback) =>
      on<{ textH: number; viewportH: number }>('overlay:geometry', callback),
  }
  contextBridge.exposeInMainWorld('controlsApi', api)
} else if (surface === 'overlay') {
  const api: OverlayApi = {
    bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
    togglePlayback: () => ipcRenderer.invoke('playback:toggle'),
    focusControls: () => ipcRenderer.invoke('controls:focus'),
    checkpoint: (input) => ipcRenderer.invoke('playback:checkpoint', input),
    reportGeometry: (geometry) => ipcRenderer.invoke('overlay:reportGeometry', geometry),
    dragStart: (screenX, screenY) =>
      ipcRenderer.invoke('overlay:dragStart', { screenX, screenY }),
    dragUpdate: (screenX, screenY) =>
      ipcRenderer.invoke('overlay:dragUpdate', { screenX, screenY }),
    dragEnd: () => ipcRenderer.invoke('overlay:dragEnd'),
    resizeStart: (screenX, screenY, edge) =>
      ipcRenderer.invoke('overlay:resizeStart', { screenX, screenY, edge }),
    resizeUpdate: (screenX, screenY) =>
      ipcRenderer.invoke('overlay:resizeUpdate', { screenX, screenY }),
    resizeEnd: () => ipcRenderer.invoke('overlay:resizeEnd'),
    openEditor: () => ipcRenderer.invoke('overlay:openEditor'),
    onSnapshot: (callback) => on<OverlaySnapshot>('snapshot:changed', callback),
    onActiveDocument: (callback) => on<DocumentContent | null>('document:changed', callback),
  }
  contextBridge.exposeInMainWorld('overlayApi', api)
} else {
  throw new Error('unknown Teleprompt preload surface')
}

export type { ControlsApi, OverlayApi, DocumentContent, DocumentFormat, DocumentId }
