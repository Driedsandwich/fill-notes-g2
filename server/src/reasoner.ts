import type { Fill, FetchLike, Reason, Reasoner } from './types.ts'

export const TAGS = [
  'take-profit',
  'stop-loss',
  'scale-in',
  'scale-out',
  'breakout',
  'dip-buy',
  'rebalance',
] as const

/** Rule-based candidates. No network. Describes why a trade *could* have been made; gives no advice. */
export function rulesReasons(fill: Fill, recent: Fill[]): Reason[] {
  const prev = [...recent].reverse().find((f) => f.symbol === fill.symbol && f.id !== fill.id)
  const movePct = prev ? ((fill.price - prev.price) / prev.price) * 100 : 0
  const score: Record<string, number> = Object.fromEntries(TAGS.map((t) => [t, 0]))
  const add = (tag: string, n: number) => {
    score[tag] = (score[tag] ?? 0) + n
  }

  if (fill.side === 'SELL') {
    if (fill.pnl !== null && fill.pnl > 0) add('take-profit', 5)
    if (fill.pnl !== null && fill.pnl < 0) add('stop-loss', 5)
    if (fill.pnl === null) {
      add('rebalance', 2)
      add('take-profit', 1)
    }
    add('scale-out', 3)
    add('rebalance', 1)
    if (movePct < -0.5) add('stop-loss', 2)
    if (movePct > 0.5) add('take-profit', 2)
  } else {
    if (movePct > 0.5) add('breakout', 5)
    if (movePct < -0.5) add('dip-buy', 5)
    if (prev && prev.side === 'BUY') add('scale-in', 4)
    add('scale-in', 2)
    add('rebalance', 1)
    add('breakout', 1)
    add('dip-buy', 1)
  }

  const order = new Map(TAGS.map((t, i) => [t as string, i]))
  const ranked = Object.entries(score)
    .sort((a, b) => b[1] - a[1] || order.get(a[0])! - order.get(b[0])!)
    .slice(0, 3)
  return ranked.map(([tag]) => ({ tag }))
}

export const rulesReasoner: Reasoner = async (fill, recent) => rulesReasons(fill, recent)

export interface OpenAICompatOptions {
  baseUrl: string
  apiKey: string
  model: string
  fetchImpl?: FetchLike
  timeoutMs?: number
}

function sanitizeTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return t || null
}

export function parseLlmReasons(text: string): Reason[] | null {
  const m = text.match(/\[[\s\S]*\]/)
  if (!m) return null
  let arr: unknown
  try {
    arr = JSON.parse(m[0])
  } catch {
    return null
  }
  if (!Array.isArray(arr)) return null
  const out: Reason[] = []
  for (const item of arr) {
    const tag = sanitizeTag(typeof item === 'string' ? item : (item as { tag?: unknown })?.tag)
    if (tag && !out.some((o) => o.tag === tag)) {
      const label = typeof item === 'object' && item && typeof (item as { label?: unknown }).label === 'string' ? (item as { label: string }).label.slice(0, 80) : undefined
      out.push(label ? { tag, label } : { tag })
    }
    if (out.length === 3) break
  }
  return out.length === 3 ? out : null
}

/** OpenAI-compatible chat completions. Any failure falls back to the rules reasoner. */
export function openAICompatibleReasoner(opts: OpenAICompatOptions): Reasoner {
  const doFetch: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i))
  return async (fill, recent) => {
    try {
      const history = recent
        .slice(-5)
        .map((f) => `${f.side} ${f.qty} ${f.symbol} @ ${f.price}`)
        .join('; ')
      const prompt =
        `A paper-trading fill just happened on an exchange testnet: ${fill.side} ${fill.qty} ${fill.symbol} @ ${fill.price}` +
        (fill.pnl !== null ? `, realized PnL ${fill.pnl}` : '') +
        `. Recent fills: ${history || 'none'}. ` +
        'List exactly 3 short, plausible motives the trader may have had, as a JSON array of objects ' +
        '{"tag":"kebab-case-max-20-chars","label":"max 6 words"}. Describe motives only; do not give trading advice. Output JSON only.'
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000)
      let res: Response
      try {
        res = await doFetch(`${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify({
            model: opts.model,
            temperature: 0.3,
            messages: [{ role: 'user', content: prompt }],
          }),
          signal: ctrl.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}`)
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      const parsed = parseLlmReasons(json.choices?.[0]?.message?.content ?? '')
      if (!parsed) throw new Error('LLM output not parseable')
      return parsed
    } catch (e) {
      console.error(`[reasoner] falling back to rules: ${(e as Error).message}`)
      return rulesReasons(fill, recent)
    }
  }
}
