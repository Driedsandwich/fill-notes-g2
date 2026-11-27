import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { weeklyPattern } from '../src/analytics.ts'
import { JsonlJournal, NotionJournal, notionProperties, readJournalFile } from '../src/journal.ts'
import type { JournalEntry } from '../src/types.ts'
import { rmTmp, tmpDir } from './helpers.ts'

const dir = tmpDir()
afterAll(() => rmTmp(dir))

const entry = (over: Partial<JournalEntry> = {}): JournalEntry => ({
  fillId: 'f1',
  time: Date.UTC(2026, 10, 24, 3, 0, 0),
  symbol: 'ETHUSDT',
  side: 'SELL',
  qty: 0.5,
  price: 3412,
  pnl: 36,
  reason: 'take-profit',
  note: '',
  source: 'replay',
  recordedAt: Date.UTC(2026, 10, 24, 3, 0, 6),
  ...over,
})

describe('JsonlJournal', () => {
  it('creates the journal with owner-only permissions', async () => {
    const j = new JsonlJournal(path.join(dir, 'private'))
    await j.append(entry())
    expect(fs.statSync(j.file).mode & 0o077).toBe(0)
  })
  it('appends one JSON line per entry and reads them back', async () => {
    const j = new JsonlJournal(path.join(dir, 'a'))
    await j.append(entry())
    await j.append(entry({ fillId: 'f2', reason: 'custom', note: 'felt the top' }))
    const raw = fs.readFileSync(j.file, 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(2)
    const back = await j.readAll()
    expect(back.map((e) => e.fillId)).toEqual(['f1', 'f2'])
    expect(back[1]!.note).toBe('felt the top')
  })
  it('skips a damaged line instead of losing the rest', () => {
    const f = path.join(dir, 'b.jsonl')
    fs.writeFileSync(f, JSON.stringify(entry()) + '\n{broken\n' + JSON.stringify(entry({ fillId: 'f3' })) + '\n')
    expect(readJournalFile(f).map((e) => e.fillId)).toEqual(['f1', 'f3'])
  })
})

describe('Notion journal (no network)', () => {
  it('maps an entry to the documented columns', () => {
    const p = notionProperties(entry()) as Record<string, Record<string, unknown>>
    expect(Object.keys(p).sort()).toEqual(['Note', 'PnL', 'Price', 'Qty', 'Reason', 'Side', 'Source', 'Symbol', 'Time'])
    expect(p.PnL).toEqual({ number: 36 })
    expect(p.Reason).toEqual({ select: { name: 'take-profit' } })
  })
  it('omits PnL when unknown', () => {
    expect(notionProperties(entry({ pnl: null }))).not.toHaveProperty('PnL')
  })
  it('posts to the pages endpoint with a Bearer header and mirrors locally even if Notion fails', async () => {
    const calls: { url: string; auth: string | null; body: { parent: { database_id: string } } }[] = []
    const fakeFetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) })
      return new Response('{}', { status: 500 })
    }
    const j = new NotionJournal(path.join(dir, 'c'), { token: 'test-token', databaseId: 'test-db', fetchImpl: fakeFetch })
    await expect(j.append(entry())).rejects.toThrow('Notion HTTP 500')
    expect(calls[0]!.url).toBe('https://api.notion.com/v1/pages')
    expect(calls[0]!.auth).toBe('Bearer test-token')
    expect(calls[0]!.body.parent.database_id).toBe('test-db')
    expect(await j.readAll()).toHaveLength(1)
  })
})

describe('weeklyPattern', () => {
  it('counts per reason with wins, losses and average pnl', () => {
    const now = Date.UTC(2026, 10, 24, 12)
    const rows = weeklyPattern(
      [
        entry({ pnl: 40, time: now - 1000 }),
        entry({ pnl: -10, time: now - 2000 }),
        entry({ reason: 'dip-buy', pnl: null, time: now - 3000 }),
        entry({ reason: 'old', pnl: 5, time: now - 9 * 86_400_000 }),
      ],
      now,
    )
    expect(rows[0]).toEqual({ reason: 'take-profit', count: 2, wins: 1, losses: 1, avgPnl: 15 })
    expect(rows.find((r) => r.reason === 'dip-buy')).toEqual({ reason: 'dip-buy', count: 1, wins: 0, losses: 0, avgPnl: null })
    expect(rows.find((r) => r.reason === 'old')).toBeUndefined()
  })
})
