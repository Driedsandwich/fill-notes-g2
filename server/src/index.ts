import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.ts'
import { Engine } from './engine.ts'
import { createApp } from './http.ts'
import { JsonlJournal, NotionJournal } from './journal.ts'
import { loadOrCreatePairCode } from './pairing.ts'
import { openAICompatibleReasoner, rulesReasoner } from './reasoner.ts'
import { BinanceTestnetSource } from './sources/binance.ts'
import { ReplaySource, loadFixture } from './sources/replay.ts'
import { localCommandTranscriber, localHttpTranscriber, openAICompatibleTranscriber } from './stt.ts'
import type { FillSource, Journal, Reasoner, Transcriber } from './types.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Minimal .env reader (KEY=VALUE lines) so no extra dependency is needed. Real env vars win. */
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || line.trim().startsWith('#')) continue
    if (process.env[m[1]!] === undefined && m[2] !== '') process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '')
  }
}

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is required for this setting (see .env.example)`)
  return v
}

async function main(): Promise<void> {
  loadDotEnv(path.resolve(here, '../../.env'))
  loadDotEnv(path.resolve(here, '../.env'))
  const cfg = loadConfig()

  let source: FillSource
  if (cfg.fillSource === 'binance-testnet') {
    source = new BinanceTestnetSource({
      apiKey: required('BINANCE_TESTNET_API_KEY'),
      apiSecret: required('BINANCE_TESTNET_API_SECRET'),
      symbols: cfg.symbols,
      pollMs: cfg.binancePollMs,
    })
  } else {
    source = new ReplaySource({
      fixture: loadFixture(path.resolve(here, '../fixtures/fills.json')),
      firstDelayMs: cfg.replayFirstDelayMs,
      intervalMs: cfg.replayIntervalMs,
      loop: cfg.replayLoop,
    })
  }

  const reasoner: Reasoner =
    cfg.reasoner === 'openai-compatible'
      ? openAICompatibleReasoner({ baseUrl: required('LLM_BASE_URL'), apiKey: required('LLM_API_KEY'), model: required('LLM_MODEL') })
      : rulesReasoner

  const transcriber: Transcriber =
    cfg.stt === 'openai-compatible'
      ? openAICompatibleTranscriber({ baseUrl: required('STT_BASE_URL'), apiKey: required('STT_API_KEY'), model: process.env.STT_MODEL || 'whisper-1' })
      : cfg.stt === 'local-command'
        ? localCommandTranscriber({ command: required('STT_COMMAND'), args: (process.env.STT_ARGS ?? '').split(' ').filter(Boolean) })
        : cfg.stt === 'local-http'
          ? localHttpTranscriber({ baseUrl: process.env.STT_BASE_URL || 'http://127.0.0.1:8796' })
          : null

  const journal: Journal =
    cfg.journal === 'notion'
      ? new NotionJournal(cfg.dataDir, { token: required('NOTION_TOKEN'), databaseId: required('NOTION_DATABASE_ID') })
      : new JsonlJournal(cfg.dataDir)

  const engine = new Engine({ source, reasoner, transcriber, journal, limitUsd: cfg.dailyLossLimitUsd })
  await engine.init()
  const pairCode = loadOrCreatePairCode(cfg.dataDir)
  const server = createApp({ engine, pairCode })

  await new Promise<void>((resolve) => server.listen(cfg.port, '0.0.0.0', resolve))
  console.log('Fill Notes server (TESTNET ONLY, no real money)')
  console.log(`  listening : http://0.0.0.0:${cfg.port}`)
  console.log(`  pair code : ${pairCode}   (glasses app sends "Authorization: Pair ${pairCode}")`)
  console.log(`  source=${cfg.fillSource} reasoner=${cfg.reasoner} stt=${cfg.stt} journal=${cfg.journal} limit=$${cfg.dailyLossLimitUsd}`)

  await source.start((fill) => {
    engine.ingest(fill).catch((e) => console.error(`[ingest] ${(e as Error).message}`))
  })

  const timer = setInterval(() => {
    engine.tick().catch((e) => console.error(`[tick] ${(e as Error).message}`))
  }, 250)

  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    clearInterval(timer)
    await engine.close()
    server.close()
    server.closeAllConnections()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => {
  console.error(`fatal: ${(e as Error).message}`)
  process.exit(1)
})
