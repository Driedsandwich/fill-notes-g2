import { describe, expect, it } from 'vitest'
import { dayKey, dayPnl, isLimitHit } from '../src/limit.ts'
import { PnlTracker } from '../src/pnl.ts'

const at = (d: number, h: number) => new Date(2026, 10, d, h, 0, 0).getTime()

describe('daily loss limit', () => {
  it('sums only today and treats null pnl as zero', () => {
    const fills = [
      { time: at(24, 9), pnl: -120 },
      { time: at(24, 10), pnl: null },
      { time: at(24, 11), pnl: 30.5 },
      { time: at(23, 23), pnl: -999 }, // yesterday
    ]
    expect(dayPnl(fills, at(24, 12))).toBe(-89.5)
  })
  it('hits exactly at -limit and not just above', () => {
    expect(isLimitHit(-199.99, 200)).toBe(false)
    expect(isLimitHit(-200, 200)).toBe(true)
    expect(isLimitHit(-350, 200)).toBe(true)
    expect(isLimitHit(50, 200)).toBe(false)
  })
  it('a limit of 0 or less disables the check', () => {
    expect(isLimitHit(-1000, 0)).toBe(false)
  })
  it('resets on the next calendar day', () => {
    expect(dayKey(at(24, 23))).not.toBe(dayKey(at(25, 0)))
    expect(dayPnl([{ time: at(24, 9), pnl: -500 }], at(25, 9))).toBe(0)
  })
})

describe('PnlTracker (average cost)', () => {
  it('computes realized pnl on sells and ignores unknown positions', () => {
    const t = new PnlTracker()
    expect(t.apply('ETHUSDT', 'SELL', 1, 3000)).toBeNull() // nothing held
    expect(t.apply('ETHUSDT', 'BUY', 1, 3000)).toBeNull()
    expect(t.apply('ETHUSDT', 'BUY', 1, 3200)).toBeNull() // avg 3100
    expect(t.apply('ETHUSDT', 'SELL', 0.5, 3300)).toBe(100)
    expect(t.position('ETHUSDT').qty).toBeCloseTo(1.5)
  })
})
