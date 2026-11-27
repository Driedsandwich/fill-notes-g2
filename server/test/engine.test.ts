import { describe, expect, it, vi } from 'vitest'
import { ConflictError, Engine, NotFoundError, VoiceUnavailableError } from '../src/engine.ts'
import { rulesReasoner } from '../src/reasoner.ts'
import { FakeClock, FakeSource, MemJournal, mkFill } from './helpers.ts'

const T0 = new Date(2026, 10, 24, 12, 0, 0).getTime()

function make(over: { transcriber?: ((p: Uint8Array) => Promise<string>) | null; limitUsd?: number } = {}) {
  const clock = new FakeClock(T0)
  const journal = new MemJournal()
  const source = new FakeSource()
  const engine = new Engine({ source, reasoner: rulesReasoner, transcriber: over.transcriber ?? null, journal, limitUsd: over.limitUsd ?? 200, clock })
  return { clock, journal, source, engine }
}

describe('engine: prompt -> note -> undo window', () => {
  it('shows a prompt with 3 reasons, then "saved", and writes only after 5 seconds', async () => {
    const { clock, journal, engine } = make()
    await engine.ingest(mkFill({ id: 'f1', time: T0 }))
    let s = engine.getState()
    expect(s.mode).toBe('prompt')
    expect(s.prompt!.reasons).toHaveLength(3)
    expect(s.prompt!.line).toBe('SELL 0.5 ETH @ 3,412 +$10.00')

    s = await engine.note({ fillId: 'f1', reasonIndex: 0 })
    expect(s.mode).toBe('saved')
    expect(s.saved!.msLeft).toBe(5000)
    expect(journal.rows).toHaveLength(0)

    clock.advance(4999)
    await engine.tick()
    expect(journal.rows).toHaveLength(0)
    expect(engine.getState().mode).toBe('saved')

    clock.advance(1)
    await engine.tick()
    expect(journal.rows).toHaveLength(1)
    expect(journal.rows[0]).toMatchObject({ fillId: 'f1', reason: 'take-profit', symbol: 'ETHUSDT' })
    expect(engine.getState().mode).toBe('idle')
    expect(engine.getState().day.notes).toBe(1)
  })

  it('undo inside the window brings the prompt back and nothing is written', async () => {
    const { clock, journal, engine } = make()
    await engine.ingest(mkFill({ id: 'f1', time: T0 }))
    await engine.note({ reasonIndex: 1 })
    clock.advance(3000)
    const s = engine.undo()
    expect(s.mode).toBe('prompt')
    expect(s.prompt!.fillId).toBe('f1')
    clock.advance(10_000)
    await engine.tick()
    expect(journal.rows).toHaveLength(0)
  })

  it('undo after the window is refused', async () => {
    const { clock, engine } = make()
    await engine.ingest(mkFill({ id: 'f1', time: T0 }))
    await engine.note({ reasonIndex: 0 })
    clock.advance(5000)
    expect(() => engine.undo()).toThrow(ConflictError)
  })

  it('a second note finalizes the first; a free-text note is stored as custom', async () => {
    const { journal, engine } = make()
    await engine.ingest(mkFill({ id: 'f1', time: T0 }))
    await engine.ingest(mkFill({ id: 'f2', time: T0 }))
    await engine.note({ fillId: 'f1', reasonIndex: 2 })
    await engine.note({ fillId: 'f2', text: '  news said so ' })
    expect(journal.rows).toHaveLength(1) // f1 finalized, f2 still in its window
    await engine.flush()
    expect(journal.rows[1]).toMatchObject({ fillId: 'f2', reason: 'custom', note: 'news said so' })
  })

  it('the "saved" confirmation is shown before the next queued fill, then the next prompt appears', async () => {
    const { clock, engine } = make()
    await engine.ingest(mkFill({ id: 'f1', time: T0 }))
    await engine.ingest(mkFill({ id: 'f2', time: T0 }))
    await engine.note({ fillId: 'f1', reasonIndex: 0 })
    let s = engine.getState()
    expect(s.mode).toBe('saved')
    expect(s.saved!.fillId).toBe('f1')
    clock.advance(5000)
    await engine.tick()
    s = engine.getState()
    expect(s.mode).toBe('prompt')
    expect(s.prompt!.fillId).toBe('f2')
  })

  it('rejects an out-of-range choice and ignores duplicate fills', async () => {
    const { engine } = make()
    await engine.ingest(mkFill({ id: 'f1', time: T0 }))
    await engine.ingest(mkFill({ id: 'f1', time: T0 }))
    await expect(engine.note({ reasonIndex: 9 })).rejects.toThrow(ConflictError)
    expect(engine.getState().prompt!.queued).toBe(0)
  })

  it('voice needs a transcriber; with one it becomes a custom note', async () => {
    const off = make()
    await off.engine.ingest(mkFill({ id: 'f1', time: T0 }))
    await expect(off.engine.voice(new Uint8Array(4000))).rejects.toThrow(VoiceUnavailableError)
    const on = make({ transcriber: async () => 'took profit early' })
    await on.engine.ingest(mkFill({ id: 'f1', time: T0 }))
    const out = await on.engine.voice(new Uint8Array(4000))
    expect(out.text).toBe('took profit early')
    expect(out.state.mode).toBe('saved')
  })

  it.each([undefined, 'other-fill'])('skips transcription when there is no matching prompt (%s)', async (fillId) => {
    const transcriber = vi.fn(async () => 'took profit early')
    const { engine } = make({ transcriber })
    if (fillId) await engine.ingest(mkFill({ id: 'f1', time: T0 }))
    const error = await engine.note({ fillId }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(NotFoundError)
    await expect(engine.voice(new Uint8Array(4000), fillId)).rejects.toThrow(error as NotFoundError)
    expect(transcriber).not.toHaveBeenCalled()
  })

  it('AI proposals add one extra choice and never confirm', async () => {
    const { journal, engine } = make()
    await engine.ingest(mkFill({ id: 'f1', time: T0 }))
    engine.propose('Hedge the Book', 'agent idea')
    engine.propose('second idea')
    const reasons = engine.getState().prompt!.reasons
    expect(reasons).toHaveLength(4)
    expect(reasons[3]).toMatchObject({ tag: 'second-idea', ai: true })
    expect(journal.rows).toHaveLength(0)
  })
})

describe('engine: daily loss limit', () => {
  async function loseTo(engine: Engine, total: number) {
    await engine.ingest(mkFill({ id: 'l1', time: T0, pnl: total }))
    await engine.note({ reasonIndex: 0 })
    await engine.flush()
  }

  it('shows the limit screen at -limit after the pending note is done, and cancels nothing by itself', async () => {
    const { engine, source } = make()
    await engine.ingest(mkFill({ id: 'l1', time: T0, pnl: -200 }))
    expect(engine.getState().mode).toBe('prompt') // note first
    expect(engine.getState().day.limitHit).toBe(true)
    await engine.note({ reasonIndex: 0 })
    await engine.flush()
    expect(engine.getState().mode).toBe('limit')
    expect(source.cancelCalls).toBe(0)
  })

  it('does not show the limit screen just above the limit', async () => {
    const { engine } = make()
    await loseTo(engine, -199.99)
    expect(engine.getState().mode).toBe('idle')
  })

  it('cancel-all is refused before the limit and runs once after a human asks', async () => {
    const a = make()
    await expect(a.engine.cancelAll()).rejects.toThrow(ConflictError)
    expect(a.source.cancelCalls).toBe(0)

    const b = make()
    await loseTo(b.engine, -250)
    const out = await b.engine.cancelAll()
    expect(out.cancelled).toBe(3)
    expect(b.source.cancelCalls).toBe(1)
    expect(out.state.mode).toBe('idle')
    expect(out.state.limit.cancelled).toBe(true)
  })

  it('"not now" hides the limit screen for the day without touching orders', async () => {
    const { engine, source } = make()
    await loseTo(engine, -250)
    expect(engine.getState().mode).toBe('limit')
    engine.dismissLimit()
    expect(engine.getState().mode).toBe('idle')
    expect(source.cancelCalls).toBe(0)
  })

  it('daily PnL survives a restart through the journal', async () => {
    const a = make()
    await loseTo(a.engine, -250)
    const clock = new FakeClock(T0 + 60_000)
    const b = new Engine({ source: new FakeSource(), reasoner: rulesReasoner, transcriber: null, journal: a.journal, limitUsd: 200, clock })
    await b.init()
    expect(b.getState().day.pnl).toBe(-250)
    expect(b.getState().mode).toBe('limit')
  })
})
