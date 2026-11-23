export type Side = 'BUY' | 'SELL'
export type FillSourceName = 'replay' | 'binance-testnet'

/** One execution (fill) on the exchange. `pnl` is realized PnL in quote currency (USD-like), null when unknown. */
export interface Fill {
  id: string
  time: number // epoch ms
  symbol: string
  side: Side
  qty: number
  price: number
  pnl: number | null
  source: FillSourceName
}

export interface Reason {
  tag: string // short label shown on the glasses, e.g. "take-profit"
  label?: string // optional longer text (kept in the note column when chosen)
  ai?: boolean // true when proposed by an AI agent via MCP
}

export interface JournalEntry {
  fillId: string
  time: number
  symbol: string
  side: Side
  qty: number
  price: number
  pnl: number | null
  reason: string
  note: string
  source: FillSourceName
  recordedAt: number
}

export interface Journal {
  append(entry: JournalEntry): Promise<void>
  readAll(): Promise<JournalEntry[]>
}

/** Where fills come from. `start` pushes each *new* fill to `onFill`. */
export interface FillSource {
  readonly name: FillSourceName
  start(onFill: (fill: Fill) => void): Promise<void> | void
  stop(): void
  /** Cancel every open order (testnet only). Returns how many were cancelled. */
  cancelAllOpenOrders(): Promise<number>
  /** Number of open orders, or null if unknown. */
  countOpenOrders(): Promise<number | null>
}

export type Reasoner = (fill: Fill, recent: Fill[]) => Promise<Reason[]>
export type Transcriber = ((pcm: Uint8Array) => Promise<string>) | null

export interface Clock {
  now(): number
}
export const systemClock: Clock = { now: () => Date.now() }

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>
