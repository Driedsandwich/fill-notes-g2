/**
 * Realized PnL for spot trades using the running average cost per symbol.
 * Long-only: a SELL without a tracked position has unknown PnL (null).
 * Fees are ignored (documented limitation).
 */
export class PnlTracker {
  private pos = new Map<string, { qty: number; avg: number }>()

  /** Feed one trade in time order. Returns realized PnL for SELL, null for BUY or unknown. */
  apply(symbol: string, side: 'BUY' | 'SELL', qty: number, price: number): number | null {
    const p = this.pos.get(symbol) ?? { qty: 0, avg: 0 }
    if (side === 'BUY') {
      const total = p.qty + qty
      p.avg = total > 0 ? (p.avg * p.qty + price * qty) / total : 0
      p.qty = total
      this.pos.set(symbol, p)
      return null
    }
    if (p.qty <= 0) return null
    const closed = Math.min(qty, p.qty)
    const realized = (price - p.avg) * closed
    p.qty -= closed
    if (p.qty <= 1e-12) {
      p.qty = 0
      p.avg = 0
    }
    this.pos.set(symbol, p)
    return round(realized)
  }

  position(symbol: string): { qty: number; avg: number } {
    return { ...(this.pos.get(symbol) ?? { qty: 0, avg: 0 }) }
  }
}

export function round(n: number, digits = 2): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}
