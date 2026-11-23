import fs from 'node:fs'
import path from 'node:path'
import type { Clock, Fill, FillSource, Journal, JournalEntry } from '../src/types.ts'

export function tmpDir(): string {
  const base = path.join(process.cwd(), '.tmp')
  fs.mkdirSync(base, { recursive: true })
  return fs.mkdtempSync(path.join(base, 'test-'))
}

export function rmTmp(dir: string): void {
  if (!dir.includes(`${path.sep}.tmp${path.sep}test-`)) throw new Error('refusing to delete outside .tmp/test-*')
  fs.rmSync(dir, { recursive: true, force: true })
}

export class FakeClock implements Clock {
  constructor(public t: number) {}
  now(): number {
    return this.t
  }
  advance(ms: number): void {
    this.t += ms
  }
}

export class MemJournal implements Journal {
  rows: JournalEntry[] = []
  async append(e: JournalEntry): Promise<void> {
    this.rows.push(e)
  }
  async readAll(): Promise<JournalEntry[]> {
    return [...this.rows]
  }
}

export class FakeSource implements FillSource {
  readonly name = 'replay' as const
  cancelCalls = 0
  open = 3
  start(): void {}
  stop(): void {}
  async cancelAllOpenOrders(): Promise<number> {
    this.cancelCalls += 1
    const n = this.open
    this.open = 0
    return n
  }
  async countOpenOrders(): Promise<number> {
    return this.open
  }
}

export function mkFill(over: Partial<Fill> & { id: string }): Fill {
  return { time: 0, symbol: 'ETHUSDT', side: 'SELL', qty: 0.5, price: 3412, pnl: 10, source: 'replay', ...over }
}
