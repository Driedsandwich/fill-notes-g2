import fs from 'node:fs'
import path from 'node:path'
import type { FetchLike, Journal, JournalEntry } from './types.ts'

export class JsonlJournal implements Journal {
  readonly file: string
  constructor(dir: string) {
    this.file = path.join(dir, 'journal.jsonl')
  }

  async append(entry: JournalEntry): Promise<void> {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', 'utf8')
  }

  async readAll(): Promise<JournalEntry[]> {
    return readJournalFile(this.file)
  }
}

export function readJournalFile(file: string): JournalEntry[] {
  if (!fs.existsSync(file)) return []
  const out: JournalEntry[] = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as JournalEntry)
    } catch {
      // skip a damaged line rather than lose the rest
    }
  }
  return out
}

/**
 * Notion DB schema this expects (property name: type):
 * Symbol: title, Time: date, Side: select, Qty: number, Price: number,
 * PnL: number, Reason: select, Note: rich_text, Source: select.
 */
export function notionProperties(e: JournalEntry): Record<string, unknown> {
  const props: Record<string, unknown> = {
    Symbol: { title: [{ text: { content: e.symbol } }] },
    Time: { date: { start: new Date(e.time).toISOString() } },
    Side: { select: { name: e.side } },
    Qty: { number: e.qty },
    Price: { number: e.price },
    Reason: { select: { name: e.reason } },
    Note: { rich_text: e.note ? [{ text: { content: e.note.slice(0, 1900) } }] : [] },
    Source: { select: { name: e.source } },
  }
  if (e.pnl !== null) props.PnL = { number: e.pnl }
  return props
}

export interface NotionOptions {
  token: string
  databaseId: string
  fetchImpl?: FetchLike
}

/** Writes to Notion and mirrors every entry into the local JSONL (the MCP tools and weekly pattern read the local file). */
export class NotionJournal implements Journal {
  private local: JsonlJournal
  private doFetch: FetchLike
  constructor(
    dir: string,
    private opts: NotionOptions,
  ) {
    this.local = new JsonlJournal(dir)
    this.doFetch = opts.fetchImpl ?? ((u, i) => fetch(u, i))
  }

  async append(entry: JournalEntry): Promise<void> {
    await this.local.append(entry) // local copy first so a Notion outage never loses a note
    const res = await this.doFetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        'notion-version': '2022-06-28',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        parent: { database_id: this.opts.databaseId },
        properties: notionProperties(entry),
      }),
    })
    if (!res.ok) throw new Error(`Notion HTTP ${res.status}`)
  }

  readAll(): Promise<JournalEntry[]> {
    return this.local.readAll()
  }
}
