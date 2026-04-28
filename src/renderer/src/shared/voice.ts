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
  private restartAttempts = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private getScriptTokens: () => Token[],
    private getCurrentTokenIdx: () => number,
    private onAdvance: (tokenIdx: number) => void,
    private onError?: (msg: string) => void,
  ) {}

  start(lang = 'en-US'): boolean {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!Ctor) {
      this.onError?.('Web Speech API not available')
      return false
    }
    if (this.running) return true

    const rec = new Ctor()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = lang

    rec.onresult = (event) => {
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

    rec.onerror = (e) => {
      const code = String(e?.error ?? 'unknown')
      if (FATAL_ERRORS.has(code)) {
        this.running = false
        this.onError?.(`voice disabled: ${code}`)
      } else {
        this.onError?.(`recognition error: ${code}`)
      }
    }

    rec.onend = () => {
      if (!this.running) return
      if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
        this.running = false
        this.onError?.('voice recognition kept failing — giving up')
        return
      }
      this.restartAttempts += 1
      const delay = 250 * this.restartAttempts
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        if (!this.running || !this.rec) return
        try {
          this.rec.start()
        } catch {
          /* swallow — onend will fire again or remain stopped */
        }
      }, delay)
    }

    this.rec = rec
    this.running = true
    this.restartAttempts = 0
    try {
      rec.start()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'start failed'
      this.onError?.(msg)
      this.running = false
      this.rec = null
      return false
    }
    return true
  }

  stop() {
    this.running = false
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.rec) {
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
