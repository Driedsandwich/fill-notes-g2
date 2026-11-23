import fs from 'node:fs'
import type { Clock, Fill, FillSource } from '../types.ts'
import { systemClock } from '../types.ts'

export interface ReplayFixture {
  fills: { symbol: string; side: 'BUY' | 'SELL'; qty: number; price: number; pnl: number | null }[]
  openOrders: { symbol: string; orderId: number; side: string; qty: number; price: number }[]
}

export function loadFixture(file: string): ReplayFixture {
  const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ReplayFixture>
  return { fills: j.fills ?? [], openOrders: j.openOrders ?? [] }
}

export interface ReplayOptions {
  fixture: ReplayFixture
  firstDelayMs: number
  intervalMs: number
  loop: boolean
  clock?: Clock
}

/** Replays fictional sample fills with the current time. Never touches the network. */
export class ReplaySource implements FillSource {
  readonly name = 'replay' as const
  private index = 0
  private round = 0
  private timer: NodeJS.Timeout | null = null
  private onFill: ((f: Fill) => void) | null = null
  private open: ReplayFixture['openOrders']
  private clock: Clock
  private runId: string

  constructor(private opts: ReplayOptions) {
    this.open = [...opts.fixture.openOrders]
    this.clock = opts.clock ?? systemClock
    this.runId = this.clock.now().toString(36)
  }

  start(onFill: (f: Fill) => void): void {
    this.onFill = onFill
    this.schedule(this.opts.firstDelayMs)
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      if (this.emitNext()) this.schedule(this.opts.intervalMs)
    }, ms)
  }

  /** Emit the next sample fill. Returns false when the sample is exhausted. */
  emitNext(): boolean {
    const list = this.opts.fixture.fills
    if (list.length === 0) return false
    if (this.index >= list.length) {
      if (!this.opts.loop) return false
      this.index = 0
      this.round += 1
    }
    const s = list[this.index]!
    const fill: Fill = {
      id: `replay-${this.runId}-${this.round}-${this.index + 1}`,
      time: this.clock.now(),
      symbol: s.symbol,
      side: s.side,
      qty: s.qty,
      price: s.price,
      pnl: s.pnl,
      source: 'replay',
    }
    this.index += 1
    this.onFill?.(fill)
    return true
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  async cancelAllOpenOrders(): Promise<number> {
    const n = this.open.length
    this.open = []
    return n
  }

  async countOpenOrders(): Promise<number> {
    return this.open.length
  }
}
