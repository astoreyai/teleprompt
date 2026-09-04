type RecognitionAlternative = { transcript: string; confidence: number }
type RecognitionResult = {
  readonly length: number
  readonly isFinal: boolean
  [index: number]: RecognitionAlternative
}
type RecognitionResultList = {
  readonly length: number
  [index: number]: RecognitionResult
}
type RecognitionEvent = {
  resultIndex: number
  results: RecognitionResultList
}
type RecognitionErrorEvent = { error: string; message?: string }

type Recognizer = {
  start(): void
  stop(): void
  abort(): void
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: RecognitionEvent) => void) | null
  onerror: ((event: RecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
}

declare global {
  interface Window {
    SpeechRecognition?: { new (): Recognizer }
    webkitSpeechRecognition?: { new (): Recognizer }
  }
}

export type Token = { word: string; start: number; end: number }

export function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  const re = /[A-Za-z0-9']+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    tokens.push({ word: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length })
  }
  return tokens
}

export function indexOfFirstTokenAtOrAfterChar(tokens: Token[], char: number): number {
  let lo = 0
  let hi = tokens.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (tokens[mid].end <= char) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function progressForToken(tokens: Token[], tokenIndex: number, totalChars: number): number {
  if (tokens.length === 0 || !Number.isFinite(totalChars) || totalChars <= 0) return 0
  const index = Math.max(0, Math.min(tokens.length - 1, Math.trunc(tokenIndex)))
  return Math.max(0, Math.min(1, tokens[index].start / totalChars))
}

export type VoiceMatchOptions = {
  lookaheadTokens?: number
  windowSize?: number
  minMatch?: number
}

export function alignSpokenWindow(
  scriptTokens: Token[],
  currentTokenIdx: number,
  spokenWords: string[],
  opts: VoiceMatchOptions = {},
): number | null {
  const { lookaheadTokens = 40, windowSize = 4, minMatch = 3 } = opts
  if (spokenWords.length < minMatch) return null
  const tail = spokenWords.slice(-windowSize)
  const start = currentTokenIdx
  const end = Math.min(scriptTokens.length, currentTokenIdx + lookaheadTokens)

  let bestScore = 0
  let bestIdx: number | null = null

  for (let i = start; i + tail.length <= end; i++) {
    let score = 0
    for (let j = 0; j < tail.length; j++) {
      if (scriptTokens[i + j].word === tail[j]) score++
    }
    if (score > bestScore) {
      bestScore = score
      bestIdx = i + tail.length
    }
  }
  if (bestScore >= Math.min(minMatch, tail.length)) return bestIdx
  return null
}

const FATAL_ERRORS = new Set(['not-allowed', 'service-not-allowed', 'audio-capture'])
const MAX_RESTART_ATTEMPTS = 5

export class VoicePacer {
  private rec: Recognizer | null = null
  private spoken: string[] = []
  private running = false
  private generation = 0
  private restartAttempts = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private getScriptTokens: () => Token[],
    private getCurrentTokenIdx: () => number,
    private onAdvance: (tokenIdx: number) => void,
    private onError?: (msg: string) => void,
    private onStatus?: (status: 'starting' | 'active') => void,
  ) {}

  start(lang = 'en-US'): boolean {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!Ctor) {
      this.onError?.('Web Speech API not available')
      return false
    }
    if (this.running) return true

    const generation = ++this.generation
    let rec: Recognizer
    try { rec = new Ctor() }
    catch (error) {
      this.onError?.(error instanceof Error ? error.message : 'Speech recognition could not initialize')
      return false
    }
    const current = () => this.running && this.rec === rec && this.generation === generation
    const fail = (message: string) => {
      if (!current()) return
      this.stop()
      this.onError?.(message)
    }
    const restart = () => {
      if (!current() || this.restartTimer) return
      if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
        fail('Voice recognition kept failing; enable voice pacing to retry.')
        return
      }
      this.restartAttempts += 1
      this.onStatus?.('starting')
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        if (!current()) return
        try { rec.start() }
        catch { restart() }
      }, 250 * this.restartAttempts)
    }
    rec.continuous = true
    rec.interimResults = true
    rec.lang = lang

    rec.onstart = () => { if (current()) this.onStatus?.('active') }
    rec.onresult = (event) => {
      if (!current()) return
      this.restartAttempts = 0
      let transcript = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript + ' '
      }
      const words = transcript
        .toLowerCase()
        .match(/[a-z0-9']+/g)
        ?.slice(-12)
      if (!words) return
      this.spoken = words
      const tokens = this.getScriptTokens()
      const cur = this.getCurrentTokenIdx()
      const next = alignSpokenWindow(tokens, cur, this.spoken)
      if (next !== null && next > cur) this.onAdvance(next)
    }

    rec.onerror = (event) => {
      if (!current()) return
      const code = String(event.error ?? 'unknown')
      if (FATAL_ERRORS.has(code)) fail(`Voice disabled: ${code}`)
      else this.onStatus?.('starting')
    }
    rec.onend = restart

    this.rec = rec
    this.running = true
    this.restartAttempts = 0
    this.onStatus?.('starting')
    try {
      rec.start()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'start failed'
      fail(msg)
      return false
    }
    return true
  }

  stop() {
    this.generation += 1
    this.running = false
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.rec) {
      this.rec.onresult = null
      this.rec.onerror = null
      this.rec.onend = null
      this.rec.onstart = null
      try {
        this.rec.abort()
      } catch {
        /* ignore */
      }
      this.rec = null
    }
    this.spoken = []
    this.restartAttempts = 0
  }
}
