import type { Fill } from './types.ts'

/** Local calendar day key, e.g. "2026-11-24". */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

export function dayPnl(fills: Pick<Fill, 'time' | 'pnl'>[], now: number): number {
  const key = dayKey(now)
  let sum = 0
  for (const f of fills) if (dayKey(f.time) === key && f.pnl !== null) sum += f.pnl
  return Math.round(sum * 100) / 100
}

/** True when today's realized loss has reached the limit (PnL <= -limit). A limit <= 0 disables the check. */
export function isLimitHit(pnl: number, limitUsd: number): boolean {
  if (!(limitUsd > 0)) return false
  return pnl <= -limitUsd
}
