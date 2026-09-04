import { readFile, readdir } from 'node:fs/promises'

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
