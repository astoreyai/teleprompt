export class PlaybackCheckpointGate {
  private lastSentAt: number | null = null
  private lastPosition: number | null = null

  constructor(
    private readonly intervalMs = 250,
    private readonly meaningfulJump = 1,
  ) {}

  shouldSend(input: { now: number; position: number; terminal: boolean }): boolean {
    const first = this.lastSentAt === null || this.lastPosition === null
    const intervalElapsed = !first && input.now - this.lastSentAt! >= this.intervalMs
    const jumped = !first && Math.abs(input.position - this.lastPosition!) >= this.meaningfulJump
    const send = first || input.terminal || intervalElapsed || jumped
    if (send) {
      this.lastSentAt = input.now
      this.lastPosition = input.position
    }
    return send
  }

  reset(): void {
    this.lastSentAt = null
    this.lastPosition = null
  }
}
