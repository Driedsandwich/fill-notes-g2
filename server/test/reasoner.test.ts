import { describe, expect, it } from 'vitest'
import { TAGS, openAICompatibleReasoner, parseLlmReasons, rulesReasons } from '../src/reasoner.ts'
import { mkFill } from './helpers.ts'

describe('rulesReasons', () => {
  it('returns 3 distinct known tags', () => {
    const r = rulesReasons(mkFill({ id: 'a' }), [])
    expect(r).toHaveLength(3)
    expect(new Set(r.map((x) => x.tag)).size).toBe(3)
    for (const x of r) expect(TAGS).toContain(x.tag)
  })
  it('profitable SELL ranks take-profit first', () => {
    expect(rulesReasons(mkFill({ id: 'a', side: 'SELL', pnl: 36 }), [])[0]!.tag).toBe('take-profit')
  })
  it('losing SELL ranks stop-loss first', () => {
    expect(rulesReasons(mkFill({ id: 'a', side: 'SELL', pnl: -50 }), [])[0]!.tag).toBe('stop-loss')
  })
  it('BUY after a rise ranks breakout first, after a fall dip-buy first', () => {
    const prev = mkFill({ id: 'p', side: 'SELL', price: 3000, pnl: 1 })
    expect(rulesReasons(mkFill({ id: 'a', side: 'BUY', price: 3100, pnl: null }), [prev])[0]!.tag).toBe('breakout')
    expect(rulesReasons(mkFill({ id: 'b', side: 'BUY', price: 2900, pnl: null }), [prev])[0]!.tag).toBe('dip-buy')
  })
})

describe('openAICompatibleReasoner', () => {
  const base = { baseUrl: 'https://llm.invalid/v1', apiKey: 'test-key', model: 'm' }
  it('parses a valid reply from an injected fetch', async () => {
    const reply = '[{"tag":"Take Profit","label":"locked a gain"},{"tag":"rebalance"},{"tag":"scale-out"}]'
    const f = async () => new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { status: 200 })
    const r = await openAICompatibleReasoner({ ...base, fetchImpl: f })(mkFill({ id: 'a' }), [])
    expect(r.map((x) => x.tag)).toEqual(['take-profit', 'rebalance', 'scale-out'])
  })
  it('falls back to rules on HTTP error', async () => {
    const f = async () => new Response('no', { status: 500 })
    const fill = mkFill({ id: 'a', pnl: 36 })
    const r = await openAICompatibleReasoner({ ...base, fetchImpl: f })(fill, [])
    expect(r).toEqual(rulesReasons(fill, []))
  })
  it('falls back to rules on garbage output and on thrown errors', async () => {
    const fill = mkFill({ id: 'a', pnl: -5 })
    const garbage = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'sorry' } }] }), { status: 200 })
    expect(await openAICompatibleReasoner({ ...base, fetchImpl: garbage })(fill, [])).toEqual(rulesReasons(fill, []))
    const boom = async () => {
      throw new Error('offline')
    }
    expect(await openAICompatibleReasoner({ ...base, fetchImpl: boom })(fill, [])).toEqual(rulesReasons(fill, []))
  })
  it('parseLlmReasons needs exactly 3 distinct tags', () => {
    expect(parseLlmReasons('[{"tag":"a"},{"tag":"a"},{"tag":"b"}]')).toBeNull()
    expect(parseLlmReasons('x [{"tag":"a"},{"tag":"b"},{"tag":"c"},{"tag":"d"}] y')).toHaveLength(3)
  })
})
