import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { PresentationDriver } from './presentation.js'

// Real X11 servers, event windows and xdotool processes; no fabricated platform,
// injected executable lookup, child-process doubles, or synthetic events.
const children: ChildProcess[] = []
const originalDisplay = process.env.DISPLAY
const originalSession = process.env.XDG_SESSION_TYPE
afterEach(async () => {
  for (const child of children.splice(0).reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    await exited
  }
  if (originalDisplay === undefined) delete process.env.DISPLAY
  else process.env.DISPLAY = originalDisplay
  if (originalSession === undefined) delete process.env.XDG_SESSION_TYPE
  else process.env.XDG_SESSION_TYPE = originalSession
})

async function eventWindow() {
  const server = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '800x600x24', '-nolisten', 'tcp'], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
  })
  children.push(server)
  let display = ''
  ;(server.stdio[3] as Readable).on('data', (bytes) => { display += String(bytes) })
  await expect.poll(() => display.trim(), { timeout: 5000 }).toMatch(/^\d+$/)
  process.env.DISPLAY = `:${display.trim()}`
  process.env.XDG_SESSION_TYPE = 'x11'
  const window = spawn('stdbuf', ['-oL', 'xev', '-event', 'keyboard'], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(window)
  let events = ''
  window.stdout!.on('data', (bytes) => { events += String(bytes) })
  await expect.poll(() => events).toMatch(/Outer window is 0x[0-9a-f]+/i)
  const id = events.match(/Outer window is (0x[0-9a-f]+)/i)![1]
  execFileSync('xdotool', ['windowfocus', '--sync', id])
  return { server, events: () => events }
}

describe('presentation driver with actual isolated X11 processes', () => {
  it('sends both directions to a real focused event window', async () => {
    const window = await eventWindow()
    const driver = new PresentationDriver()
    expect(driver.capability()).toEqual({ ok: true })
    driver.sendKey('advance')
    await expect.poll(window.events).toContain('Right')
    driver.sendKey('back')
    await expect.poll(window.events).toContain('Left')
  }, 15_000)

  it('survives an actual X server disappearing after capability discovery', async () => {
    const window = await eventWindow()
    const driver = new PresentationDriver()
    expect(driver.capability()).toEqual({ ok: true })
    const exited = new Promise<void>((resolve) => window.server.once('exit', () => resolve()))
    window.server.kill('SIGTERM')
    await exited
    expect(() => driver.sendKey('advance')).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 100))
  }, 15_000)
})
