import type { RendererRole } from '../../shared/ipc.js'

type IpcPolicy = { roles: readonly RendererRole[] }

const CONTROLS = ['controls'] as const
const OVERLAY = ['overlay'] as const
const BOTH = ['controls', 'overlay'] as const

export const IPC_POLICY = {
  'app:bootstrap': { roles: BOTH },
  'documents:open': { roles: CONTROLS },
  'documents:openRecent': { roles: CONTROLS },
  'documents:openDropped': { roles: CONTROLS },
  'documents:create': { roles: CONTROLS },
  'documents:select': { roles: CONTROLS },
  'documents:remove': { roles: CONTROLS },
  'documents:update': { roles: CONTROLS },
  'documents:save': { roles: CONTROLS },
  'documents:reload': { roles: CONTROLS },
  'playback:toggle': { roles: BOTH },
  'playback:restart': { roles: CONTROLS },
  'playback:seek': { roles: CONTROLS },
  'playback:checkpoint': { roles: OVERLAY },
  'preferences:update': { roles: CONTROLS },
  'preferences:reset': { roles: CONTROLS },
  'preferences:clearRecent': { roles: CONTROLS },
  'preferences:export': { roles: CONTROLS },
  'preferences:import': { roles: CONTROLS },
  'preferences:about': { roles: CONTROLS },
  'overlay:setVisible': { roles: CONTROLS },
  'overlay:reportGeometry': { roles: OVERLAY },
  'overlay:dragStart': { roles: OVERLAY },
  'overlay:dragUpdate': { roles: OVERLAY },
  'overlay:dragEnd': { roles: OVERLAY },
  'overlay:resizeStart': { roles: OVERLAY },
  'overlay:resizeUpdate': { roles: OVERLAY },
  'overlay:resizeEnd': { roles: OVERLAY },
  'overlay:openEditor': { roles: OVERLAY },
  'controls:focus': { roles: OVERLAY },
  'voice:request': { roles: CONTROLS },
  'voice:grantConsent': { roles: CONTROLS },
  'voice:revokeConsent': { roles: CONTROLS },
  'voice:status': { roles: CONTROLS },
  'clicker:setArmed': { roles: CONTROLS },
  'presentation:setArmed': { roles: CONTROLS },
  'presentation:status': { roles: CONTROLS },
  'hotkeys:update': { roles: CONTROLS },
  'hotkeys:status': { roles: CONTROLS },
  'platform:info': { roles: CONTROLS },
} as const satisfies Record<string, IpcPolicy>

export type IpcChannel = keyof typeof IPC_POLICY

export function authorizeIpc(
  channel: string,
  context: {
    role: RendererRole | null
    frameUrl: string
    expectedUrl: string | null
    isMainFrame: boolean
  },
): boolean {
  const policy = IPC_POLICY[channel as IpcChannel] as IpcPolicy | undefined
  if (!policy || !context.role || !policy.roles.includes(context.role)) return false
  if (!context.isMainFrame || !context.expectedUrl) return false
  return normalizeUrl(context.frameUrl) === normalizeUrl(context.expectedUrl)
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}
