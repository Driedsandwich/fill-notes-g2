import crypto from 'node:crypto'
import type { Clock, FetchLike, Fill, FillSource } from '../types.ts'
import { systemClock } from '../types.ts'
import { PnlTracker, round } from '../pnl.ts'

export const TESTNET_BASE = 'https://testnet.binance.vision/api'

/** HMAC SHA256 hex of the query string (Binance signed endpoints). */
export function hmacSha256Hex(secret: string, message: string): string {
  return crypto.createHmac('sha256', secret).update(message).digest('hex')
}

/** Build `k=v&k=v&signature=<hex>`. Param order is kept; the signature covers everything before it. */
export function signQuery(params: Record<string, string | number>, secret: string): string {
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
  return `${qs}&signature=${hmacSha256Hex(secret, qs)}`
}

export interface RawTrade {
  id: number
  orderId: number
  price: string
  qty: string
  quoteQty: string
  time: number
  isBuyer: boolean
}

export interface BinanceOptions {
  apiKey: string
  apiSecret: string
  symbols: string[]
  pollMs: number
  baseUrl?: string
  fetchImpl?: FetchLike
  clock?: Clock
}

/** Merge trades that belong to the same order (a market order can fill in pieces). Input must be sorted by id. */
export function mergeByOrder(symbol: string, trades: RawTrade[]): Omit<Fill, 'pnl' | 'source'>[] {
  const groups = new Map<number, RawTrade[]>()
  for (const t of trades) {
    const g = groups.get(t.orderId) ?? []
    g.push(t)
    groups.set(t.orderId, g)
  }
  const out: Omit<Fill, 'pnl' | 'source'>[] = []
  for (const [orderId, g] of groups) {
    const qty = g.reduce((a, t) => a + Number(t.qty), 0)
    const quote = g.reduce((a, t) => a + Number(t.price) * Number(t.qty), 0)
    out.push({
      id: `bn-${symbol}-${orderId}-${g[0]!.id}`,
      time: Math.max(...g.map((t) => t.time)),
      symbol,
      side: g[0]!.isBuyer ? 'BUY' : 'SELL',
      qty: round(qty, 8),
      price: round(quote / qty, 8),
    })
  }
  return out.sort((a, b) => a.time - b.time)
}

/** Reads the testnet account's trades (signed GET /api/v3/myTrades). Keys come only from the constructor. */
export class BinanceTestnetSource implements FillSource {
  readonly name = 'binance-testnet' as const
  private tracker = new PnlTracker()
  private lastId = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null
  private doFetch: FetchLike
  private clock: Clock
  private base: string
  private onFill: ((f: Fill) => void) | null = null
  private stopped = false

  constructor(private opts: BinanceOptions) {
    this.doFetch = opts.fetchImpl ?? ((u, i) => fetch(u, i))
    this.clock = opts.clock ?? systemClock
    this.base = (opts.baseUrl ?? TESTNET_BASE).replace(/\/+$/, '')
  }

  private async signed(method: 'GET' | 'DELETE', path: string, params: Record<string, string | number>): Promise<Response> {
    const qs = signQuery({ ...params, recvWindow: 5000, timestamp: this.clock.now() }, this.opts.apiSecret)
    return this.doFetch(`${this.base}${path}?${qs}`, { method, headers: { 'X-MBX-APIKEY': this.opts.apiKey } })
  }

  /** One polling round. The first round per symbol is a baseline: history feeds the cost basis but raises no prompt. */
  async pollOnce(): Promise<Fill[]> {
    const emitted: Fill[] = []
    for (const symbol of this.opts.symbols) {
      const last = this.lastId.get(symbol)
      const params: Record<string, string | number> = { symbol, limit: 1000 }
      if (last !== undefined) params.fromId = last + 1
      const res = await this.signed('GET', '/v3/myTrades', params)
      if (!res.ok) throw new Error(`myTrades ${symbol} HTTP ${res.status}`)
      const trades = ((await res.json()) as RawTrade[]).sort((a, b) => a.id - b.id)
      if (trades.length === 0) {
        if (last === undefined) this.lastId.set(symbol, 0)
        continue
      }
      this.lastId.set(symbol, trades[trades.length - 1]!.id)
      const merged = mergeByOrder(symbol, trades)
      for (const m of merged) {
        const pnl = this.tracker.apply(symbol, m.side, m.qty, m.price)
        if (last !== undefined) emitted.push({ ...m, pnl, source: 'binance-testnet' })
      }
    }
    for (const f of emitted) this.onFill?.(f)
    return emitted
  }

  async start(onFill: (f: Fill) => void): Promise<void> {
    this.onFill = onFill
    const tick = async () => {
      if (this.stopped) return
      try {
        await this.pollOnce()
      } catch (e) {
        console.error(`[binance] poll failed: ${(e as Error).message}`)
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.opts.pollMs)
    }
    await tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
  }

  async countOpenOrders(): Promise<number | null> {
    let n = 0
    for (const symbol of this.opts.symbols) {
      const res = await this.signed('GET', '/v3/openOrders', { symbol })
      if (!res.ok) return null
      n += ((await res.json()) as unknown[]).length
    }
    return n
  }

  /** DELETE /api/v3/openOrders per symbol. Only called after a human pressed "yes" on the glasses. */
  async cancelAllOpenOrders(): Promise<number> {
    let n = 0
    for (const symbol of this.opts.symbols) {
      const res = await this.signed('DELETE', '/v3/openOrders', { symbol })
      if (res.ok) {
        n += ((await res.json()) as unknown[]).length
      } else if (res.status === 400) {
        const body = (await res.json().catch(() => ({}))) as { code?: number }
        if (body.code !== -2011) throw new Error(`cancel ${symbol} HTTP 400 code ${body.code}`) // -2011 = nothing to cancel
      } else {
        throw new Error(`cancel ${symbol} HTTP ${res.status}`)
      }
    }
    return n
  }
}
