/**
 * MCP server (stdio) so AI agents can use the same trade notes.
 * stdout is the MCP wire: log to stderr only.
 * Reads the journal file directly; talks to the running HTTP server for the pending prompt and proposals.
 * AI can only *propose* a reason. Confirming one is a tap on the glasses.
 */
import fs from 'node:fs'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { weeklyPattern } from './analytics.ts'
import { readJournalFile } from './journal.ts'

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'))
const baseUrl = (process.env.FILL_NOTES_URL || 'http://localhost:8787').replace(/\/+$/, '')

function pairCode(): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dataDir, 'pair.json'), 'utf8')) as { code: string }).code
  } catch {
    throw new Error(`pair code not found in ${dataDir}/pair.json (start the server first, or set DATA_DIR)`)
  }
}

async function callServer(method: 'GET' | 'POST', route: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { authorization: `Pair ${pairCode()}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`server ${res.status}: ${JSON.stringify(json)}`)
  return json
}

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] })

const server = new McpServer({ name: 'fill-notes', version: '0.1.0' })

server.registerTool(
  'list_trades_with_notes',
  {
    description: 'List recorded testnet trades with the reason the trader chose (newest first). Testnet only; not financial advice.',
    inputSchema: { limit: z.number().int().min(1).max(200).optional(), symbol: z.string().optional() },
  },
  async ({ limit, symbol }) => {
    let rows = readJournalFile(path.join(dataDir, 'journal.jsonl')).reverse()
    if (symbol) rows = rows.filter((r) => r.symbol === symbol.toUpperCase())
    return text(rows.slice(0, limit ?? 50))
  },
)

server.registerTool(
  'get_weekly_pattern',
  {
    description: 'Per reason tag over the last 7 days: count, wins, losses and average PnL. Descriptive statistics only.',
    inputSchema: { days: z.number().int().min(1).max(90).optional() },
  },
  async ({ days }) => text(weeklyPattern(readJournalFile(path.join(dataDir, 'journal.jsonl')), Date.now(), days ?? 7)),
)

server.registerTool(
  'get_pending_prompt',
  { description: 'The fill currently waiting for a reason on the glasses, with its candidate reasons (or null).', inputSchema: {} },
  async () => text(await callServer('GET', '/api/pending')),
)

server.registerTool(
  'propose_reason',
  {
    description: 'Suggest one extra reason for the pending fill. It is shown as an additional choice marked as AI; it never confirms anything. The human decides on the glasses.',
    inputSchema: { tag: z.string().min(1).max(40), label: z.string().max(80).optional(), fillId: z.string().optional() },
  },
  async ({ tag, label, fillId }) => text(await callServer('POST', '/api/propose', { tag, label, fillId })),
)

await server.connect(new StdioServerTransport())
console.error('fill-notes MCP server ready (stdio)')
