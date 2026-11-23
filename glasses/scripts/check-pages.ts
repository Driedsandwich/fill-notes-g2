// Offline check of the 6 screens. The SDK validator (checked with a negative control) only covers z-order/menu rules,
// so the rules from the glasses-ui guide are asserted here too: <=12 containers, exactly one event capture,
// unique ids, unique names <=16 chars, text <=1000 chars.
import { formatEvenHubPageContainerValidationError, validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk'
import type { ServerState } from '../src/api.ts'
import { buildScreen, lossBar, toCreate, toRebuild } from '../src/screens.ts'

const base: ServerState = {
  version: 1,
  mode: 'idle',
  testnet: true,
  now: 0,
  day: { date: '2026-11-24', notes: 3, pnl: -84.2, limit: 200, limitHit: false },
  prompt: null,
  saved: null,
  limit: { hit: false, dismissed: false, cancelled: false, cancelledCount: 0 },
}
const prompt: ServerState = {
  ...base,
  mode: 'prompt',
  prompt: { fillId: 'f1', line: 'SELL 0.5 ETH @ 3,412 +$36.00', reasons: [{ tag: 'take-profit', label: '', ai: false }, { tag: 'scale-out', label: '', ai: false }, { tag: 'rebalance', label: '', ai: false }, { tag: 'hedge', label: '', ai: true }], queued: 1 },
}
const cases: [string, ServerState | null, { configured: boolean; online: boolean; flash: string }][] = [
  ['setup', null, { configured: false, online: false, flash: '' }],
  ['offline', null, { configured: true, online: false, flash: '' }],
  ['idle', base, { configured: true, online: true, flash: '' }],
  ['prompt', prompt, { configured: true, online: true, flash: 'Listening... release to send' }],
  ['saved', { ...base, mode: 'saved', saved: { fillId: 'f1', reason: 'take-profit', expiresAt: 5000, msLeft: 5000 } }, { configured: true, online: true, flash: '' }],
  ['limit', { ...base, mode: 'limit', day: { ...base.day, pnl: -216.61, limitHit: true } }, { configured: true, online: true, flash: '' }],
]

function rules(sc: ReturnType<typeof buildScreen>): string[] {
  const all = [...sc.text, ...sc.list]
  const errs: string[] = []
  if (all.length > 12) errs.push('more than 12 containers')
  if (all.filter((c) => c.isEventCapture === 1).length !== 1) errs.push('need exactly one isEventCapture')
  if (new Set(all.map((c) => c.containerID)).size !== all.length) errs.push('duplicate containerID')
  if (new Set(all.map((c) => c.containerName)).size !== all.length) errs.push('duplicate containerName')
  if (all.some((c) => (c.containerName ?? '').length > 16)) errs.push('containerName > 16 chars')
  if (sc.text.some((t) => (t.content ?? '').length > 1000)) errs.push('text > 1000 chars')
  if (sc.list.some((l) => (l.itemContainer?.itemName ?? []).some((n) => n.length > 64))) errs.push('list item > 64 chars')
  return errs
}

let bad = 0
for (const [name, s, ctx] of cases) {
  const sc = buildScreen(s, ctx)
  const re = rules(sc)
  if (re.length) {
    bad++
    console.log(`FAIL ${name}: ${re.join('; ')}`)
  }
  for (const [label, page] of [['create', toCreate(sc)], ['rebuild', toRebuild(sc)]] as const) {
    const r = validateEvenHubPageContainer(page as never)
    const ok = r.valid !== false && !('errors' in r && Array.isArray(r.errors) && r.errors.length)
    if (!ok) {
      bad++
      console.log(`FAIL ${name}/${label}: ${formatEvenHubPageContainerValidationError(r as never)}`)
    } else console.log(`ok   ${name}/${label}: ${sc.text.length} text + ${sc.list.length} list`)
  }
  const chars = sc.text.map((t) => t.content ?? '').join('\n')
  console.log('     ' + JSON.stringify(chars).slice(0, 160))
}
console.log('bar 0/200:', lossBar(0, 200), ' 100/200:', lossBar(-100, 200), ' 216/200:', lossBar(-216, 200))
process.exit(bad ? 1 : 0)
