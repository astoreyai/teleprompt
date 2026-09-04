import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const reviewed = JSON.parse(await readFile('test/real-input-review.json', 'utf8'))
async function tests(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? tests(path) : /\.test\.tsx?$/.test(entry.name) ? [path] : []
  }))).flat()
}
const pending = []
for (const file of await tests('src')) {
  const hash = createHash('sha256').update(await readFile(file)).digest('hex')
  if (reviewed.files[file] !== hash) pending.push(file)
}
if (pending.length) {
  process.stderr.write(`Full release qualification is blocked by ${pending.length} unreviewed real-input suites:\n${pending.join('\n')}\n`)
  process.stderr.write('The review manifest must record actual reviewed and executed suite hashes; it cannot certify missing corpus or unexecuted tests.\n')
  process.exit(1)
}
