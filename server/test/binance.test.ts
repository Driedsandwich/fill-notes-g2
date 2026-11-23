import { describe, expect, it } from 'vitest'
import { BinanceTestnetSource, hmacSha256Hex, mergeByOrder, signQuery, type RawTrade } from '../src/sources/binance.ts'
import { FakeClock } from './helpers.ts'

// Expected values were produced independently with: printf '%s' <message> | openssl dgst -sha256 -hmac 'test-secret'
describe('HMAC SHA256 signing', () => {
  it('matches the openssl value for a known message', () => {
    expect(hmacSha256Hex('test-secret', 'abc')).toBe('e4c4dadd6571f81a7b019d216db1ef3877b0c88faabc56a66f8897ee32857593')
  })
  it('signs the query string in order and appends signature last', () => {
    const q = signQuery({ symbol: 'ETHUSDT', limit: 1000, recvWindow: 5000, timestamp: 1700000000000 }, 'test-secret')
    expect(q).toBe('symbol=ETHUSDT&limit=1000&recvWindow=5000&timestamp=1700000000000&signature=94fd09f972e0dcf3d84c7eea3b345e19ac909254cb6d4a56579e08cbc173b0a5')
  })
})

const trade = (id: number, orderId: number, price: string, qty: string, isBuyer: boolean, time = 1000 + id): RawTrade => ({
  id,
  orderId,
  price,
  qty,
  quoteQty: String(Number(price) * Number(qty)),
  time,
  isBuyer,
})

describe('mergeByOrder', () => {
  it('merges partial fills of one order into a VWAP fill', () => {
    const out = mergeByOrder('ETHUSDT', [trade(1, 77, '3000', '1', true), trade(2, 77, '3100', '1', true), trade(3, 78, '3200', '0.5', false)])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ side: 'BUY', qty: 2, price: 3050, id: 'bn-ETHUSDT-77-1' })
    expect(out[1]).toMatchObject({ side: 'SELL', qty: 0.5 })
  })
})

describe('BinanceTestnetSource with an injected fetch', () => {
  function setup(responses: RawTrade[][]) {
    const calls: { url: string; method: string; key: string | null }[] = []
    let i = 0
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', key: new Headers(init?.headers).get('x-mbx-apikey') })
      return new Response(JSON.stringify(responses[Math.min(i++, responses.length - 1)]), { status: 200 })
    }
    const src = new BinanceTestnetSource({ apiKey: 'test-key', apiSecret: 'test-secret', symbols: ['ETHUSDT'], pollMs: 5000, fetchImpl, clock: new FakeClock(1700000000000) })
    return { src, calls }
  }

  it('first poll is a baseline: no prompts, but it builds cost basis; later polls emit with pnl', async () => {
    const { src, calls } = setup([[trade(1, 10, '3000', '1', true)], [trade(2, 11, '3300', '0.5', false)]])
    expect(await src.pollOnce()).toEqual([])
    const second = await src.pollOnce()
    expect(second).toHaveLength(1)
    expect(second[0]).toMatchObject({ side: 'SELL', qty: 0.5, price: 3300, pnl: 150, source: 'binance-testnet' })
    // request shape
    expect(calls[0]!.url).toMatch(/^https:\/\/testnet\.binance\.vision\/api\/v3\/myTrades\?symbol=ETHUSDT&limit=1000&recvWindow=5000&timestamp=1700000000000&signature=[0-9a-f]{64}$/)
    expect(calls[0]!.key).toBe('test-key')
    expect(calls[1]!.url).toContain('fromId=2')
  })

  it('cancel-all uses DELETE /openOrders per symbol and counts cancelled orders', async () => {
    const calls: { url: string; method: string }[] = []
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' })
      return new Response(JSON.stringify([{ orderId: 1 }, { orderId: 2 }]), { status: 200 })
    }
    const src = new BinanceTestnetSource({ apiKey: 'k', apiSecret: 'test-secret', symbols: ['ETHUSDT'], pollMs: 1, fetchImpl, clock: new FakeClock(1) })
    expect(await src.cancelAllOpenOrders()).toBe(2)
    expect(calls[0]!.method).toBe('DELETE')
    expect(calls[0]!.url).toContain('/api/v3/openOrders?symbol=ETHUSDT')
  })

  it('treats Binance -2011 (nothing to cancel) as zero', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ code: -2011, msg: 'Unknown order sent.' }), { status: 400 })
    const src = new BinanceTestnetSource({ apiKey: 'k', apiSecret: 's', symbols: ['ETHUSDT'], pollMs: 1, fetchImpl, clock: new FakeClock(1) })
    expect(await src.cancelAllOpenOrders()).toBe(0)
  })
})
