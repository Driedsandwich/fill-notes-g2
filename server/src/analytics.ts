import type { JournalEntry } from './types.ts'

export interface PatternRow {
  reason: string
  count: number
  wins: number
  losses: number
  avgPnl: number | null // average over entries that have a pnl
}

/** Per-reason counts and win/loss averages over the last `days` days. */
export function weeklyPattern(entries: JournalEntry[], now: number, days = 7): PatternRow[] {
  const since = now - days * 86_400_000
  const by = new Map<string, JournalEntry[]>()
  for (const e of entries) {
    if (e.time < since) continue
    const list = by.get(e.reason) ?? []
    list.push(e)
    by.set(e.reason, list)
  }
  const rows: PatternRow[] = []
  for (const [reason, list] of by) {
    const withPnl = list.filter((e) => e.pnl !== null) as (JournalEntry & { pnl: number })[]
    const sum = withPnl.reduce((a, e) => a + e.pnl, 0)
    rows.push({
      reason,
      count: list.length,
      wins: withPnl.filter((e) => e.pnl > 0).length,
      losses: withPnl.filter((e) => e.pnl < 0).length,
      avgPnl: withPnl.length ? Math.round((sum / withPnl.length) * 100) / 100 : null,
    })
  }
  return rows.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
}
