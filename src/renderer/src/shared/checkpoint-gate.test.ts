import { describe, expect, it } from 'vitest'
import { PlaybackCheckpointGate } from './checkpoint-gate.js'

describe('playback checkpoint gate', () => {
  it('keeps animation local and emits at most four routine checkpoints per second', () => {
    const gate = new PlaybackCheckpointGate(250)
    expect(gate.shouldSend({ now: 0, position: 0, terminal: false })).toBe(true)
    expect(gate.shouldSend({ now: 50, position: 0.1, terminal: false })).toBe(false)
    expect(gate.shouldSend({ now: 249, position: 0.2, terminal: false })).toBe(false)
    expect(gate.shouldSend({ now: 250, position: 0.3, terminal: false })).toBe(true)
  })

  it('always sends terminal positions and meaningful external jumps', () => {
    const gate = new PlaybackCheckpointGate(250, 0.05)
    expect(gate.shouldSend({ now: 0, position: 0.1, terminal: false })).toBe(true)
    expect(gate.shouldSend({ now: 10, position: 0.9, terminal: false })).toBe(true)
    expect(gate.shouldSend({ now: 11, position: 1, terminal: true })).toBe(true)
    gate.reset()
    expect(gate.shouldSend({ now: 12, position: 0.2, terminal: false })).toBe(true)
  })
})
