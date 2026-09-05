import { app, utilityProcess } from 'electron'
import type { ParserWorkerHandle } from './supervisor.js'

export function spawnElectronParser(
  modulePath: string,
  options: { maxRssBytes?: number } = {},
): ParserWorkerHandle {
  const maxRssBytes = options.maxRssBytes ?? 512 * 1024 * 1024
  if (!Number.isSafeInteger(maxRssBytes) || maxRssBytes < 1) throw new Error('invalid parser memory limit')
  const child = utilityProcess.fork(modulePath, [], {
    env: safeParserEnvironment(),
    execArgv: [],
    stdio: 'ignore',
    serviceName: 'Teleprompt document parser',
  })
  let terminationRequested = false
  let exited = false
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined
  let memoryTimer: ReturnType<typeof setInterval> | undefined
  const errorListeners = new Set<(error: Error) => void>()
  const forceKill = () => {
    const pid = child.pid
    if (exited || pid === undefined) return
    try { process.kill(pid, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        console.error('Unable to terminate parser process:', (error as NodeJS.ErrnoException).code)
      }
    }
  }
  const terminate = () => {
    if (exited || child.pid === undefined) return
    try { child.kill() } catch {
      // Still attempt SIGKILL if Chromium's graceful termination races exit.
    }
    if (forceKillTimer) return
    // SIGTERM cannot terminate a stopped worker. Keep ownership until Electron
    // reports exit, and escalate so timed-out workers cannot accumulate.
    forceKillTimer = setTimeout(forceKill, 250)
    forceKillTimer.unref()
  }
  const fail = (error: Error) => {
    terminationRequested = true
    clearInterval(memoryTimer)
    for (const listener of errorListeners) listener(error)
    forceKill()
  }
  child.on('spawn', () => {
    if (terminationRequested) { terminate(); return }
    // Electron reports workingSetSize in KiB. This is a sampled watchdog,
    // not a kernel-enforced ceiling: growth can overshoot between observations.
    memoryTimer = setInterval(() => {
      if (exited || terminationRequested || child.pid === undefined) return
      try {
        const metric = app.getAppMetrics().find(process => process.pid === child.pid)
        if (metric && metric.memory.workingSetSize * 1024 > maxRssBytes) {
          fail(new Error(`parser memory limit exceeded (${metric.memory.workingSetSize * 1024} > ${maxRssBytes} bytes)`))
        }
      } catch {
        fail(new Error('unable to measure parser memory'))
      }
    }, 50)
    memoryTimer.unref()
  })
  child.on('error', () => { terminationRequested = true; terminate() })
  child.once('exit', () => {
    exited = true
    clearTimeout(forceKillTimer)
    clearInterval(memoryTimer)
    errorListeners.clear()
  })
  return {
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => {
      child.on('message', listener)
      return () => child.off('message', listener)
    },
    onExit: (listener) => {
      child.on('exit', listener)
      return () => child.off('exit', listener)
    },
    onError: (listener) => {
      errorListeners.add(listener)
      return () => { errorListeners.delete(listener) }
    },
    kill: () => {
      terminationRequested = true
      clearInterval(memoryTimer)
      terminate()
    },
  }
}

function safeParserEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']) {
    const value = process.env[key]
    if (value) environment[key] = value
  }
  return environment
}
