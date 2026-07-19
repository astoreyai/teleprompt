import type { ControlsApi, OverlayApi } from '../shared/ipc.js'

declare global {
  interface Window {
    controlsApi: ControlsApi
    overlayApi: OverlayApi
  }
}

export {}
