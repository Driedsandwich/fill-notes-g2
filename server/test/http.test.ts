import type { AddressInfo } from 'node:net'
import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Engine } from '../src/engine.ts'
import { createApp } from '../src/http.ts'
import { rulesReasoner } from '../src/reasoner.ts'
import { FakeClock, FakeSource, MemJournal, mkFill } from './helpers.ts'

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
