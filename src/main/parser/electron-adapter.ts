import { utilityProcess } from 'electron'
import type { ParserWorkerHandle } from './supervisor.js'

export function spawnElectronParser(modulePath: string): ParserWorkerHandle {
  const child = utilityProcess.fork(modulePath, [], {
    env: safeParserEnvironment(),
    execArgv: [],
    stdio: 'ignore',
    serviceName: 'Teleprompt document parser',
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
    kill: () => {
      child.kill()
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
