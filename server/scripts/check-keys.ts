/**
 * Checks the Binance testnet key and the Notion token without printing them.
 * Prints only lengths, shape checks and HTTP status codes. Both calls are free, read-only requests.
 *   scripts/keychain-env.sh npx tsx scripts/check-keys.ts
 */
import { signQuery, TESTNET_BASE } from '../src/sources/binance.ts'

function shape(name: string, v: string | undefined): boolean {
  const raw = v ?? ''
  const t = raw.trim()
  console.log(`${name}: length=${raw.length} trimmed=${t.length} whitespace_or_control=${/[\s\x00-\x1f]/.test(raw)}`)
  return t.length > 0
}

const key = process.env.BINANCE_TESTNET_API_KEY
const secret = process.env.BINANCE_TESTNET_API_SECRET
const notion = process.env.NOTION_TOKEN

if (shape('BINANCE_TESTNET_API_KEY', key) && shape('BINANCE_TESTNET_API_SECRET', secret)) {
  const qs = signQuery({ timestamp: Date.now(), recvWindow: 10000 }, secret!.trim())
  const res = await fetch(`${TESTNET_BASE}/v3/account?${qs}`, { headers: { 'X-MBX-APIKEY': key!.trim() } })
  let assets = -1
  try {
    const j = (await res.json()) as { balances?: unknown[] }
    assets = Array.isArray(j.balances) ? j.balances.length : -1
  } catch {}
  console.log(`binance testnet /v3/account: http=${res.status} balances=${assets}`)
}

if (shape('NOTION_TOKEN', notion)) {
  const res = await fetch('https://api.notion.com/v1/users/me', {
    headers: { authorization: `Bearer ${notion!.trim()}`, 'Notion-Version': '2022-06-28' },
  })
  let type = '?'
  try {
    type = ((await res.json()) as { type?: string }).type ?? '?'
  } catch {}
  console.log(`notion /v1/users/me: http=${res.status} type=${type}`)
}
