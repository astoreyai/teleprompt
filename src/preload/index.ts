import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppState, HotkeyCommand, ScriptFile } from '../shared/types.js'

const api = {
  getState: (): Promise<AppState> => ipcRenderer.invoke('state:get'),
  patchState: (patch: Partial<AppState>): Promise<AppState> =>
    ipcRenderer.invoke('state:patch', patch),
  openFiles: (): Promise<{ loaded: ScriptFile[]; errors: { path: string; error: string }[] }> =>
    ipcRenderer.invoke('files:open'),
  loadFromPath: (
    path: string,
  ): Promise<{ ok: true; file: ScriptFile } | { ok: false; error: string }> =>
    ipcRenderer.invoke('files:loadPath', path),
  loadFromContent: (name: string, content: string, path?: string): Promise<ScriptFile> =>
    ipcRenderer.invoke('files:loadContent', name, content, path),
  removeFile: (index: number): Promise<void> => ipcRenderer.invoke('files:remove', index),
  selectFile: (index: number): Promise<void> => ipcRenderer.invoke('files:select', index),
  reloadCurrent: (): Promise<void> => ipcRenderer.invoke('files:reload'),
  togglePlay: (): Promise<void> => ipcRenderer.invoke('playback:toggle'),
  setScrollPosition: (position: number): Promise<void> =>
    ipcRenderer.invoke('scroll:set', position),
  updateContent: (index: number, content: string): Promise<void> =>
    ipcRenderer.invoke('files:updateContent', index, content),
  saveCurrent: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('files:save'),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  getHotkeyStatus: (): Promise<{ failed: string[] }> => ipcRenderer.invoke('hotkeys:status'),
  getPlatformInfo: (): Promise<{
    platform: NodeJS.Platform
    displayServer: string
    contentProtectionSupported: boolean
  }> => ipcRenderer.invoke('platform:info'),
  getPresentationStatus: (): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('presentation:status'),
  focusControls: (): Promise<void> => ipcRenderer.invoke('controls:focus'),
  toggleControls: (): Promise<void> => ipcRenderer.invoke('controls:toggle'),
  reportOverlayGeom: (geom: { textH: number; viewportH: number }): Promise<void> =>
    ipcRenderer.invoke('overlay:reportGeom', geom),
  dragStart: (sx: number, sy: number): Promise<void> => ipcRenderer.invoke('drag:start', sx, sy),
  dragUpdate: (sx: number, sy: number): Promise<void> => ipcRenderer.invoke('drag:update', sx, sy),
  dragEnd: (): Promise<void> => ipcRenderer.invoke('drag:end'),
  resizeStart: (sx: number, sy: number, edge: string): Promise<void> =>
    ipcRenderer.invoke('resize:start', sx, sy, edge),
  resizeUpdate: (sx: number, sy: number): Promise<void> =>
    ipcRenderer.invoke('resize:update', sx, sy),
  resizeEnd: (): Promise<void> => ipcRenderer.invoke('resize:end'),
  onOverlayGeom: (cb: (geom: { textH: number; viewportH: number }) => void) => {
    const listener = (_: unknown, g: { textH: number; viewportH: number }) => cb(g)
    ipcRenderer.on('overlay:geom', listener)
    return () => ipcRenderer.off('overlay:geom', listener)
  },
  resetSettings: (): Promise<AppState> => ipcRenderer.invoke('settings:reset'),
  exportSettings: (): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('settings:export'),
  importSettings: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('settings:import'),
  getAbout: (): Promise<{
    appVersion: string
    electronVersion: string
    nodeVersion: string
    storePath: string
  }> => ipcRenderer.invoke('settings:about'),
  onState: (cb: (state: AppState) => void) => {
    const listener = (_: unknown, state: AppState) => cb(state)
    ipcRenderer.on('state:update', listener)
    return () => ipcRenderer.off('state:update', listener)
  },
  onCommand: (cb: (cmd: HotkeyCommand) => void) => {
    const listener = (_: unknown, cmd: HotkeyCommand) => cb(cmd)
    ipcRenderer.on('command', listener)
    return () => ipcRenderer.off('command', listener)
  },
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
