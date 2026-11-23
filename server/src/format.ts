import type { Fill } from './types.ts'

const QUOTES = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'USD']

export function baseAsset(symbol: string): string {
  for (const q of QUOTES) if (symbol.endsWith(q) && symbol.length > q.length) return symbol.slice(0, -q.length)
  return symbol
}

function trim(n: number, maxDecimals: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: maxDecimals, minimumFractionDigits: 0 })
}

export function formatPrice(p: number): string {
  return trim(p, p >= 100 ? 2 : p >= 1 ? 4 : 8)
}

export function formatQty(q: number): string {
  return trim(q, 6)
}

export function formatPnl(p: number): string {
  const sign = p < 0 ? '-' : '+'
  return `${sign}$${Math.abs(p).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** "SELL 0.5 ETH @ 3,412 +$36.00" */
export function fillLine(f: Fill): string {
  const base = `${f.side} ${formatQty(f.qty)} ${baseAsset(f.symbol)} @ ${formatPrice(f.price)}`
  return f.pnl === null ? base : `${base} ${formatPnl(f.pnl)}`
}
