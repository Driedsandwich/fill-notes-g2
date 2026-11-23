/** Mirror of the server's PublicState (only the fields the glasses use). */
export interface ServerState {
  version: number
  mode: 'idle' | 'prompt' | 'saved' | 'limit'
  testnet: true
  now: number
  day: { date: string; notes: number; pnl: number; limit: number; limitHit: boolean }
  prompt: null | {
    fillId: string
    line: string
    reasons: { tag: string; label: string; ai: boolean }[]
    queued: number
  }
  saved: null | { fillId: string; reason: string; expiresAt: number; msLeft: number }
  limit: { hit: boolean; dismissed: boolean; cancelled: boolean; cancelledCount: number }
}

export interface Settings {
  server: string
  pair: string
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Plain fetch client. Auth is a header, so SSE is read from a fetch stream (EventSource cannot send headers). */
export class Api {
  private s: Settings
  constructor(s: Settings) {
    this.s = s
  }

  update(s: Settings): void {
    this.s = s
  }

  get configured(): boolean {
    return /^https?:\/\//.test(this.s.server) && /^\d{6}$/.test(this.s.pair)
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Pair ${this.s.pair}`, ...extra }
  }

  private url(path: string): string {
    return this.s.server.replace(/\/+$/, '') + path
  }

  private async call<T>(method: string, path: string, body?: BodyInit, contentType?: string): Promise<T> {
    const res = await fetch(this.url(path), {
      method,
      headers: this.headers(contentType ? { 'content-type': contentType } : {}),
      body,
    })
    const json = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) throw new ApiError(res.status, json.error ?? `HTTP ${res.status}`)
    return json as T
  }

  state(): Promise<ServerState> {
    return this.call('GET', '/api/state')
  }
  note(fillId: string, reasonIndex: number): Promise<ServerState> {
    return this.call('POST', '/api/note', JSON.stringify({ fillId, reasonIndex }), 'application/json')
  }
  undo(): Promise<ServerState> {
    return this.call('POST', '/api/undo')
  }
  voice(pcm: Uint8Array, fillId?: string): Promise<{ text: string; state: ServerState }> {
    const q = fillId ? `?fillId=${encodeURIComponent(fillId)}` : ''
    return this.call('POST', `/api/voice${q}`, pcm as BodyInit, 'application/octet-stream')
  }
  cancelAll(): Promise<{ cancelled: number; state: ServerState }> {
    return this.call('POST', '/api/limit/cancel-all')
  }
  dismissLimit(): Promise<ServerState> {
    return this.call('POST', '/api/limit/dismiss')
  }

  /** Follow /api/events. Calls onState for every event; reconnects until the returned stop() is called. */
  subscribe(onState: (s: ServerState) => void, onStatus: (ok: boolean) => void): () => void {
    let stopped = false
    let ctrl: AbortController | null = null
    const loop = async () => {
      while (!stopped) {
        ctrl = new AbortController()
        try {
          const res = await fetch(this.url('/api/events'), { headers: this.headers(), signal: ctrl.signal })
          if (!res.ok || !res.body) throw new ApiError(res.status, 'events failed')
          onStatus(true)
          const reader = res.body.getReader()
          const dec = new TextDecoder()
          let buf = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            let i: number
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i)
              buf = buf.slice(i + 2)
              const data = block
                .split('\n')
                .filter((l) => l.startsWith('data:'))
                .map((l) => l.slice(5).trim())
                .join('')
              if (data) onState(JSON.parse(data) as ServerState)
            }
          }
        } catch {
          // fall through to the retry wait
        }
        if (stopped) return
        onStatus(false)
        await new Promise((r) => setTimeout(r, 3000))
        // after a gap, re-read the state so nothing is missed
        try {
          onState(await this.state())
        } catch {
          // still offline
        }
      }
    }
    void loop()
    return () => {
      stopped = true
      ctrl?.abort()
    }
  }
}
