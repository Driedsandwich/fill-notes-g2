import { fillLine } from './format.ts'
import { dayKey, dayPnl, isLimitHit } from './limit.ts'
import type { Clock, Fill, FillSource, Journal, JournalEntry, Reason, Reasoner, Transcriber } from './types.ts'
import { systemClock } from './types.ts'

export const UNDO_WINDOW_MS = 5000
const MAX_FILLS = 500
const MAX_PROMPTS = 20

export class VoiceUnavailableError extends Error {
  constructor() {
    super('voice is not available: STT=none on the server')
  }
}
export class NotFoundError extends Error {}
export class ConflictError extends Error {}

interface Prompt {
  fill: Fill
  reasons: Reason[]
}

interface Saved {
  prompt: Prompt
  entry: JournalEntry
  expiresAt: number
}

export type Mode = 'idle' | 'prompt' | 'saved' | 'limit'

export interface PublicState {
  version: number
  mode: Mode
  testnet: true
  source: string
  now: number
  day: { date: string; notes: number; pnl: number; limit: number; limitHit: boolean }
  prompt: null | {
    fillId: string
    line: string
    symbol: string
    side: string
    qty: number
    price: number
    pnl: number | null
    reasons: { tag: string; label: string; ai: boolean }[]
    queued: number
  }
  saved: null | { fillId: string; reason: string; expiresAt: number; msLeft: number }
  limit: { hit: boolean; dismissed: boolean; cancelled: boolean; cancelledCount: number }
}

export interface EngineDeps {
  source: FillSource
  reasoner: Reasoner
  transcriber: Transcriber
  journal: Journal
  limitUsd: number
  clock?: Clock
  undoWindowMs?: number
}

export class Engine {
  private fills: Fill[] = []
  private prompts: Prompt[] = []
  private saved: Saved | null = null
  private committed: JournalEntry[] = []
  private outbox: JournalEntry[] = []
  private dismissedDay: string | null = null
  private cancelledDay: string | null = null
  private cancelledCount = 0
  private version = 0
  private listeners = new Set<(s: PublicState) => void>()
  private clock: Clock
  private undoMs: number

  constructor(private deps: EngineDeps) {
    this.clock = deps.clock ?? systemClock
    this.undoMs = deps.undoWindowMs ?? UNDO_WINDOW_MS
  }

  /** Load today's history from the journal so the daily PnL survives a restart. */
  async init(): Promise<void> {
    this.committed = await this.deps.journal.readAll()
    for (const e of this.committed) {
      this.fills.push({ id: e.fillId, time: e.time, symbol: e.symbol, side: e.side, qty: e.qty, price: e.price, pnl: e.pnl, source: e.source })
    }
    this.fills = this.fills.slice(-MAX_FILLS)
  }

  subscribe(fn: (s: PublicState) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    this.version += 1
    const s = this.getState()
    for (const l of this.listeners) l(s)
  }

  async ingest(fill: Fill): Promise<void> {
    if (this.fills.some((f) => f.id === fill.id)) return
    const recent = this.fills.slice(-20)
    this.fills.push(fill)
    if (this.fills.length > MAX_FILLS) this.fills.shift()
    const reasons = await this.deps.reasoner(fill, recent)
    this.prompts.push({ fill, reasons: reasons.slice(0, 3) })
    if (this.prompts.length > MAX_PROMPTS) this.prompts.shift()
    this.emit()
  }

  private limitHit(now: number): boolean {
    return isLimitHit(dayPnl(this.fills, now), this.deps.limitUsd)
  }

  getState(): PublicState {
    const now = this.clock.now()
    const today = dayKey(now)
    const pnl = dayPnl(this.fills, now)
    const hit = this.limitHit(now)
    const dismissed = this.dismissedDay === today
    const cancelled = this.cancelledDay === today
    const head = this.prompts[0]
    const notesToday =
      this.committed.filter((e) => dayKey(e.time) === today).length +
      this.outbox.filter((e) => dayKey(e.time) === today).length +
      (this.saved && dayKey(this.saved.entry.time) === today ? 1 : 0)
    let mode: Mode = 'idle'
    // The "Saved" confirmation (with its undo window) wins over the next queued fill, so a tap always
    // shows what was recorded before the next prompt appears.
    if (this.saved && now < this.saved.expiresAt) mode = 'saved'
    else if (head) mode = 'prompt'
    else if (hit && !dismissed && !cancelled) mode = 'limit'
    return {
      version: this.version,
      mode,
      testnet: true,
      source: this.deps.source.name,
      now,
      day: { date: today, notes: notesToday, pnl, limit: this.deps.limitUsd, limitHit: hit },
      prompt: head
        ? {
            fillId: head.fill.id,
            line: fillLine(head.fill),
            symbol: head.fill.symbol,
            side: head.fill.side,
            qty: head.fill.qty,
            price: head.fill.price,
            pnl: head.fill.pnl,
            reasons: head.reasons.map((r) => ({ tag: r.tag, label: r.label ?? '', ai: !!r.ai })),
            queued: this.prompts.length - 1,
          }
        : null,
      saved: this.saved
        ? { fillId: this.saved.entry.fillId, reason: this.saved.entry.reason, expiresAt: this.saved.expiresAt, msLeft: Math.max(0, this.saved.expiresAt - now) }
        : null,
      limit: { hit, dismissed, cancelled, cancelledCount: this.cancelledCount },
    }
  }

  private requirePromptIndex(fillId?: string): number {
    const idx = fillId ? this.prompts.findIndex((p) => p.fill.id === fillId) : this.prompts.length ? 0 : -1
    if (idx < 0) throw new NotFoundError('no pending prompt for that fill')
    return idx
  }

  /** Confirm a reason for a pending fill. Written to the journal after the undo window. */
  async note(input: { fillId?: string; reasonIndex?: number; text?: string }): Promise<PublicState> {
    const idx = this.requirePromptIndex(input.fillId)
    const prompt = this.prompts[idx]!
    let reason: string
    let note = ''
    const text = input.text?.trim()
    if (text) {
      reason = 'custom'
      note = text.slice(0, 500)
    } else if (typeof input.reasonIndex === 'number' && Number.isInteger(input.reasonIndex) && input.reasonIndex >= 0 && input.reasonIndex < prompt.reasons.length) {
      const r = prompt.reasons[input.reasonIndex]!
      reason = r.tag
      note = r.label ?? ''
    } else {
      throw new ConflictError('reasonIndex out of range or text empty')
    }
    await this.commitSaved() // an earlier note still inside its undo window is final now
    this.prompts.splice(idx, 1)
    const f = prompt.fill
    const entry: JournalEntry = {
      fillId: f.id,
      time: f.time,
      symbol: f.symbol,
      side: f.side,
      qty: f.qty,
      price: f.price,
      pnl: f.pnl,
      reason,
      note,
      source: f.source,
      recordedAt: this.clock.now(),
    }
    this.saved = { prompt, entry, expiresAt: this.clock.now() + this.undoMs }
    this.emit()
    return this.getState()
  }

  /** Undo the last note while the window is open. The fill goes back to the front of the queue. */
  undo(): PublicState {
    if (!this.saved || this.clock.now() >= this.saved.expiresAt) throw new ConflictError('nothing to undo (window closed)')
    this.prompts.unshift(this.saved.prompt)
    this.saved = null
    this.emit()
    return this.getState()
  }

  private async commitSaved(): Promise<void> {
    const s = this.saved
    if (!s) return
    this.saved = null
    this.outbox.push(s.entry)
    await this.flushOutbox()
  }

  private async flushOutbox(): Promise<void> {
    while (this.outbox.length) {
      const e = this.outbox[0]!
      try {
        await this.deps.journal.append(e)
      } catch (err) {
        console.error(`[journal] append failed, will retry: ${(err as Error).message}`)
        return
      }
      this.outbox.shift()
      this.committed.push(e)
    }
  }

  /** Call regularly (and in tests with a fake clock). Commits notes whose undo window has closed. */
  async tick(): Promise<void> {
    if (this.saved && this.clock.now() >= this.saved.expiresAt) {
      await this.commitSaved()
      this.emit()
    } else if (this.outbox.length) {
      await this.flushOutbox()
    }
  }

  /** Commit everything now (shutdown). */
  async flush(): Promise<void> {
    await this.commitSaved()
    await this.flushOutbox()
  }

  async voice(pcm: Uint8Array, fillId?: string): Promise<{ text: string; state: PublicState }> {
    const prompt = this.prompts[this.requirePromptIndex(fillId)]!
    if (!this.deps.transcriber) throw new VoiceUnavailableError()
    const text = await this.deps.transcriber(pcm)
    if (!text) throw new ConflictError('no speech recognized')
    const state = await this.note({ fillId: prompt.fill.id, text })
    return { text, state }
  }

  /** Dismiss the limit screen for today ("not now"). Does not touch any order. */
  dismissLimit(): PublicState {
    this.dismissedDay = dayKey(this.clock.now())
    this.emit()
    return this.getState()
  }

  /** Cancel all open testnet orders. Only runs when the limit is hit, and only because a human asked. */
  async cancelAll(): Promise<{ cancelled: number; state: PublicState }> {
    if (!this.limitHit(this.clock.now())) throw new ConflictError('daily limit not reached')
    const n = await this.deps.source.cancelAllOpenOrders()
    this.cancelledDay = dayKey(this.clock.now())
    this.cancelledCount = n
    this.emit()
    return { cancelled: n, state: this.getState() }
  }

  /** An AI agent suggests a reason. It is added as an extra choice (max 1) and never confirms anything. */
  propose(tag: string, label?: string, fillId?: string): PublicState {
    const p = fillId ? this.prompts.find((x) => x.fill.id === fillId) : this.prompts[0]
    if (!p) throw new NotFoundError('no pending prompt')
    const clean = tag
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24)
    if (!clean) throw new ConflictError('empty tag')
    p.reasons = p.reasons.filter((r) => !r.ai).concat([{ tag: clean, label: label?.slice(0, 80), ai: true }])
    this.emit()
    return this.getState()
  }

  pendingPrompt(): PublicState['prompt'] {
    return this.getState().prompt
  }

  async close(): Promise<void> {
    this.deps.source.stop()
    await this.flush()
  }
}
