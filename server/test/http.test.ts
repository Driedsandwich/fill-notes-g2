import type { AddressInfo } from 'node:net'
import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Engine } from '../src/engine.ts'
import { createApp } from '../src/http.ts'
import { rulesReasoner } from '../src/reasoner.ts'
import { FakeClock, FakeSource, MemJournal, mkFill } from './helpers.ts'

function pairingApp() {
  const clock = new FakeClock(T0)
  const handleRequest = createApp({ engine, pairCode: '424242', clock }).listeners('request')[0]!
  async function state(code: string | undefined, remoteAddress = '127.0.0.1', forwardedFor = remoteAddress) {
    const response = { setHeader: vi.fn(), writeHead: vi.fn<(status: number) => void>(), end: vi.fn() }
    await handleRequest({
      method: 'GET',
      url: '/api/state',
      socket: { remoteAddress },
      headers: { authorization: code === undefined ? undefined : `Pair ${code}`, 'x-forwarded-for': forwardedFor },
    }, response)
    return response.writeHead.mock.calls[0]?.[0]
  }
  return { state, clock }
}

const wrongCodes = ['000001', '000002', '000003', '000004', '000005']
const TEN_MINUTES = 600_000

const T0 = new Date(2026, 10, 24, 12, 0, 0).getTime()
let server: http.Server
let base = ''
const clock = new FakeClock(T0)
const engine = new Engine({ source: new FakeSource(), reasoner: rulesReasoner, transcriber: null, journal: new MemJournal(), limitUsd: 200, clock })
const auth = { authorization: 'Pair 424242' }

beforeAll(async () => {
  server = createApp({ engine, pairCode: '424242' })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  server.closeAllConnections()
  server.close()
})

describe('HTTP interface (loopback only)', () => {
  it('health is open; everything else needs the pair header', async () => {
    expect((await fetch(`${base}/api/health`)).status).toBe(200)
    expect((await fetch(`${base}/api/state`)).status).toBe(401)
    expect((await fetch(`${base}/api/state`, { headers: { authorization: 'Pair 000000' } })).status).toBe(401)
    expect((await fetch(`${base}/api/state`, { headers: auth })).status).toBe(200)
  })
  it('answers the CORS preflight without auth and allows the Authorization header', async () => {
    const r = await fetch(`${base}/api/note`, { method: 'OPTIONS' })
    expect(r.status).toBe(204)
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
    expect(r.headers.get('access-control-allow-headers')).toContain('Authorization')
  })
  it('returns 400 for an invalid target and keeps serving health', async () => {
    const response = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() }
    const handleRequest = server.listeners('request')[0]!
    await handleRequest({ method: 'GET', url: 'http://[' }, response)
    expect(response.writeHead).toHaveBeenCalledWith(400, expect.any(Object))
    expect((await fetch(`${base}/api/health`)).status).toBe(200)
  })
  it('note flow: prompt -> note -> undo; voice is 501 with STT=none', async () => {
    await engine.ingest(mkFill({ id: 'h1', time: T0 }))
    const s = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as { mode: string }
    expect(s.mode).toBe('prompt')
    const n = await fetch(`${base}/api/note`, { method: 'POST', headers: auth, body: JSON.stringify({ fillId: 'h1', reasonIndex: 0 }) })
    expect(n.status).toBe(200)
    expect(((await n.json()) as { mode: string }).mode).toBe('saved')
    const u = await fetch(`${base}/api/undo`, { method: 'POST', headers: auth })
    expect(((await u.json()) as { mode: string }).mode).toBe('prompt')
    const v = await fetch(`${base}/api/voice`, { method: 'POST', headers: auth, body: new Uint8Array(4000) })
    expect(v.status).toBe(501)
    const c = await fetch(`${base}/api/limit/cancel-all`, { method: 'POST', headers: auth })
    expect(c.status).toBe(409) // limit not reached
  })
  it('SSE sends the current state first', async () => {
    const ctrl = new AbortController()
    const r = await fetch(`${base}/api/events`, { headers: auth, signal: ctrl.signal })
    const reader = r.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    ctrl.abort()
    expect(first).toContain('event: state')
    expect(first).toContain('"mode":"prompt"')
  })
})

describe('HTTP pairing', () => {
  it('limits five distinct wrong codes per address', async () => {
    const { state } = pairingApp()
    for (const [i, code] of wrongCodes.entries()) await state(code, '127.0.0.1', `192.0.2.${i + 1}`)
    expect(await state('424242')).toBe(429)
  })

  it('accepts the correct code after twenty repeats and clears earlier guesses', async () => {
    const { state } = pairingApp()
    for (let i = 0; i < 20; i++) expect(await state(wrongCodes[0]!)).toBe(401)
    for (const code of wrongCodes.slice(1, 4)) expect(await state(code)).toBe(401)
    expect(await state(undefined)).toBe(401)
    expect(await state('00001')).toBe(401)
    expect(await state('424242')).toBe(200)
    for (const code of wrongCodes.slice(1)) expect(await state(code)).toBe(401)
    expect(await state('424242')).toBe(200)
    for (const code of wrongCodes) await state(code)
    expect(await state('424242')).toBe(429)
  })

  it('accepts the correct code from a second address during a lock', async () => {
    const { state } = pairingApp()
    for (const code of wrongCodes) await state(code)
    const first = await state('424242')
    expect(await state('424242', '127.0.0.2', '127.0.0.1')).toBe(200)
    expect(first).toBe(429)
  })

  it('accepts the correct code once the lock expires', async () => {
    const { state, clock } = pairingApp()
    for (const code of wrongCodes) await state(code)
    clock.advance(TEN_MINUTES - 1)
    const during = await state('424242')
    clock.advance(1)
    expect(await state('424242')).toBe(200)
    expect(during).toBe(429)
  })
})
