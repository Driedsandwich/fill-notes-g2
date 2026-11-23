import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  TextContainerProperty,
} from '@evenrealities/even_hub_sdk'
import type { ServerState } from './api.ts'
import { BAR_EMPTY, BAR_FULL, CHECK, CURSOR, DOT, MINUS } from './glyphs.ts'

export type ScreenKind = 'setup' | 'offline' | 'idle' | 'prompt' | 'saved' | 'limit'

export interface Ctx {
  configured: boolean
  online: boolean
  flash: string // short message for the hint line ("" = none)
}

export interface Screen {
  kind: ScreenKind
  /** Same layout id = same container set, so text can be updated in place without a rebuild. */
  layout: string
  text: TextContainerProperty[]
  list: ListContainerProperty[]
}

export const W = 576
export const H = 288
const BAR_W = 24

export function money(n: number, decimals = 2): string {
  const sign = n < 0 ? MINUS : n > 0 ? '+' : ''
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`
}

/** "━━━━━───" showing how much of the daily loss limit is used. */
export function lossBar(pnl: number, limit: number, width = BAR_W): string {
  const used = limit > 0 && pnl < 0 ? Math.min(1, -pnl / limit) : 0
  const filled = Math.round(used * width)
  return BAR_FULL.repeat(filled) + BAR_EMPTY.repeat(width - filled)
}

function fullText(id: number, name: string, content: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: W,
    height: H,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 6,
    containerID: id,
    containerName: name,
    content,
    isEventCapture: 1,
  })
}

function idleContent(s: ServerState | null, ctx: Ctx): string {
  const head = `FILL NOTES ${DOT} TESTNET`
  if (!ctx.configured) return `${head}\n\nOpen the phone app and\nset the server address\nand the 6-digit pair code.`
  if (!s) return `${head}\n\n${ctx.online ? 'Loading...' : 'Server unreachable.\nRetrying...'}`
  const { day } = s
  const stopped = s.limit.cancelled ? `\nStopped for today (${s.limit.cancelledCount} orders cancelled)` : ''
  return (
    `${head}\n` +
    `Notes today: ${day.notes}\n` +
    `Day PnL: ${money(day.pnl)}\n` +
    `${lossBar(day.pnl, day.limit)}\n` +
    `limit $${day.limit}` +
    stopped +
    `\n${ctx.online ? 'Waiting for the next fill...' : 'Offline, retrying...'}`
  )
}

export function buildScreen(s: ServerState | null, ctx: Ctx): Screen {
  if (!ctx.configured || !s || s.mode === 'idle') {
    return {
      kind: !ctx.configured ? 'setup' : !s ? 'offline' : 'idle',
      layout: 'single',
      text: [fullText(1, 'main', idleContent(s, ctx))],
      list: [],
    }
  }

  if (s.mode === 'prompt' && s.prompt) {
    const p = s.prompt
    const more = p.queued > 0 ? `  (+${p.queued})` : ''
    const items = p.reasons.map((r) => (r.ai ? `AI: ${r.tag}` : r.tag))
    const header = new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: W,
      height: 64,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 6,
      containerID: 1,
      containerName: 'fill',
      content: `${p.line}${more}\nWhy?`,
      isEventCapture: 0,
    })
    const list = new ListContainerProperty({
      xPosition: 0,
      yPosition: 66,
      width: W,
      height: 188,
      borderWidth: 1,
      borderColor: 5,
      borderRadius: 4,
      paddingLength: 4,
      containerID: 2,
      containerName: 'reasons',
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: items.length,
        itemWidth: 0,
        isItemSelectBorderEn: 1,
        itemName: items,
      }),
    })
    const hint = new TextContainerProperty({
      xPosition: 0,
      yPosition: 258,
      width: W,
      height: 30,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 2,
      containerID: 3,
      containerName: 'hint',
      content: ctx.flash || `TESTNET ${DOT} Tap = save ${DOT} Hold = voice`,
      isEventCapture: 0,
    })
    // the layout id includes the list items: a list cannot be changed in place
    return { kind: 'prompt', layout: `prompt:${p.fillId}:${items.join('|')}`, text: [header, hint], list: [list] }
  }

  if (s.mode === 'saved' && s.saved) {
    return {
      kind: 'saved',
      layout: 'single',
      text: [fullText(1, 'main', `Saved ${CHECK} ${s.saved.reason}\n\nTap to undo (5s)`)],
      list: [],
    }
  }

  // limit
  const d = s.day
  return {
    kind: 'limit',
    layout: 'single',
    text: [
      fullText(
        1,
        'main',
        `TESTNET ${DOT} DAY LIMIT\n` +
          `Day PnL ${money(d.pnl)} = your limit ($${d.limit})\n\n` +
          `Cancel all open orders?\n` +
          `Filled positions stay. Nothing is sold.\n` +
          `${CURSOR} Tap: Yes, cancel open orders\n` +
          `  Swipe: Not now (keep orders)` +
          (ctx.flash ? `\n${ctx.flash}` : ''),
      ),
    ],
    list: [],
  }
}

export function toCreate(sc: Screen): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer({
    containerTotalNum: sc.text.length + sc.list.length,
    textObject: sc.text,
    listObject: sc.list.length ? sc.list : undefined,
  })
}

export function toRebuild(sc: Screen): RebuildPageContainer {
  return new RebuildPageContainer({
    containerTotalNum: sc.text.length + sc.list.length,
    textObject: sc.text,
    listObject: sc.list.length ? sc.list : undefined,
  })
}
