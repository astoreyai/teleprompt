import { readFile, readdir, readlink } from 'node:fs/promises'

export type ProcessMemory = { pid: number; rssBytes: number; pssBytes: number; privateBytes: number }

export async function processTreeMemory(pid: number): Promise<ProcessMemory[]> {
  const seen = new Set<number>()
  const visit = async (id: number): Promise<ProcessMemory[]> => {
    if (seen.has(id)) return []
    seen.add(id)
    try {
      const [smaps, children] = await Promise.all([
        readFile(`/proc/${id}/smaps_rollup`, 'utf8'),
        readdir(`/proc/${id}/task`).then(async (threads) =>
          (await Promise.all(threads.map(async (thread) => {
            try {
              return await readFile(`/proc/${id}/task/${thread}/children`, 'utf8')
            } catch (error) {
              if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return ''
              throw error
            }
          }))).join(' ')),
      ])
      const bytes = (field: string) => {
        const match = smaps.match(new RegExp(`^${field}:\\s+(\\d+)`, 'm'))
        if (!match) throw new Error(`Missing ${field} in process ${id} memory accounting`)
        return Number(match[1]) * 1024
      }
      return [{ pid: id, rssBytes: bytes('Rss'), pssBytes: bytes('Pss'),
        privateBytes: bytes('Private_Clean') + bytes('Private_Dirty') },
      ...(await Promise.all(children.trim().split(/\s+/).filter(Boolean).map(Number).map(visit))).flat()]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return []
      throw error
    }
  }
  return visit(pid)
}

export async function observeRendererSandboxes(pid: number) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const mainUserNamespace = await readlink(`/proc/${pid}/ns/user`)
      const mainPidNamespace = await readlink(`/proc/${pid}/ns/pid`)
      const processes = await processTreeMemory(pid)
      const renderers = await Promise.all(processes.map(async ({ pid: childPid }) => {
        const directory = `/proc/${childPid}`
        // Chromium may rewrite argv into one space-separated process title.
        const command = await readFile(`${directory}/cmdline`, 'utf8')
        if (!/(?:^|[\0 ])--type=renderer(?:[\0 ]|$)/.test(command)) return null
        const [status, userNamespace, pidNamespace] = await Promise.all([
          readFile(`${directory}/status`, 'utf8'),
          readlink(`${directory}/ns/user`),
          readlink(`${directory}/ns/pid`),
        ])
        const field = (name: string) => {
          const value = status.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))
          if (!value) throw new Error(`Missing ${name} in renderer ${childPid} status`)
          return Number(value[1])
        }
        return { pid: childPid,
          role: command.match(/(?:^|[\0 ])--teleprompt-surface=(controls|overlay)(?:[\0 ]|$)/)?.[1],
          seccomp: field('Seccomp'), noNewPrivs: field('NoNewPrivs'), userNamespace, pidNamespace,
          separateUserNamespace: userNamespace !== mainUserNamespace,
          separatePidNamespace: pidNamespace !== mainPidNamespace }
      }))
      return { mainUserNamespace, mainPidNamespace, renderers: renderers.filter(renderer => renderer !== null) }
    } catch (error) {
      // Enumerate the real tree again if a native child exited during observation.
      // Permission failures remain fatal; they must never erase a sandboxed process.
      if (attempt >= 2 || !['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
}
