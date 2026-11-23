import path from 'node:path'

export interface Config {
  port: number
  fillSource: 'replay' | 'binance-testnet'
  reasoner: 'rules' | 'openai-compatible'
  stt: 'none' | 'openai-compatible' | 'local-command' | 'local-http'
  journal: 'jsonl' | 'notion'
  dailyLossLimitUsd: number
  dataDir: string
  symbols: string[]
  binancePollMs: number
  replayFirstDelayMs: number
  replayIntervalMs: number
  replayLoop: boolean
}

function oneOf<T extends string>(name: string, v: string | undefined, allowed: readonly T[], def: T): T {
  if (v === undefined || v === '') return def
  if ((allowed as readonly string[]).includes(v)) return v as T
  throw new Error(`${name}=${v} is not one of: ${allowed.join(', ')}`)
}

function num(name: string, v: string | undefined, def: number): number {
  if (v === undefined || v === '') return def
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`${name}=${v} is not a number`)
  return n
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    port: num('PORT', env.PORT, 8787),
    fillSource: oneOf('FILL_SOURCE', env.FILL_SOURCE, ['replay', 'binance-testnet'] as const, 'replay'),
    reasoner: oneOf('REASONER', env.REASONER, ['rules', 'openai-compatible'] as const, 'rules'),
    stt: oneOf('STT', env.STT, ['none', 'openai-compatible', 'local-command', 'local-http'] as const, 'none'),
    journal: oneOf('JOURNAL', env.JOURNAL, ['jsonl', 'notion'] as const, 'jsonl'),
    dailyLossLimitUsd: num('DAILY_LOSS_LIMIT_USD', env.DAILY_LOSS_LIMIT_USD, 200),
    dataDir: path.resolve(env.DATA_DIR || path.join(process.cwd(), 'data')),
    symbols: (env.BINANCE_SYMBOLS || 'BTCUSDT,ETHUSDT')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    binancePollMs: num('BINANCE_POLL_MS', env.BINANCE_POLL_MS, 5000),
    replayFirstDelayMs: num('REPLAY_FIRST_DELAY_MS', env.REPLAY_FIRST_DELAY_MS, 3000),
    replayIntervalMs: num('REPLAY_INTERVAL_MS', env.REPLAY_INTERVAL_MS, 20000),
    replayLoop: (env.REPLAY_LOOP ?? '0') === '1',
  }
}
