# Fill Notes (draft)

When a fill happens on a crypto exchange **testnet**, your Even Realities G2 glasses show one line, for example `SELL 0.5 ETH @ 3,412`, and ask **Why?** with three candidate reasons.
Tap to pick one, or long-press and speak to write your own. The note lands as one row in a Notion database (or a local JSONL file when no Notion key is set).
If the day's realized loss reaches the limit you set, the glasses ask "Cancel all open orders?" and only a tap on the glasses cancels the open **testnet** orders.

TESTNET ONLY. No real money is touched. Nothing here is trading advice: the candidate reasons describe motives a trader might have had, they never say what to do.

Status: working draft. The server and its tests run offline. The glasses app builds and packs. It has not been run in the simulator or on a device by the person who wrote this README yet (see "Not verified yet").

## How it works

```
 Binance Spot TESTNET            (or)  fixtures/fills.json
  GET /api/v3/myTrades  (signed)        replay of fictional fills
              \                         /
               v                       v
        +---------------------------------------+
        |  server  (Node 22, TypeScript)        |   keys live only here
        |  fill source -> reasoner (3 reasons)  |
        |  engine: prompt / saved(5s undo) /    |--> data/journal.jsonl
        |          daily-loss limit / pairing   |--> Notion DB (optional)
        |  HTTP + SSE        MCP (stdio)        |<-- LLM / STT (optional, OpenAI-compatible)
        +-----------+---------------+-----------+
                    |               |
        phone WebView (Even app)    AI agents (Claude, etc.)
        glasses/  (Vite + Even Hub SDK)   list_trades_with_notes, get_weekly_pattern,
          -> 576x288 screens on the G2     get_pending_prompt, propose_reason
```

Glasses screens (green, text only, no font control):

1. Waiting: `FILL NOTES · TESTNET`, notes today, day PnL, a `━━━───` bar against the loss limit.
2. Fill question: the fill line, `Why?`, a list of candidate reasons. Swipe to move, tap to confirm, long-press to dictate.
3. Saved: `Saved ● <reason>` and `Tap to undo (5s)`.
4. Day limit: `Cancel all open orders?` Tap = yes, swipe = not now.

## Quick start

```bash
# 1. server (replay mode: fictional fills, no network, no keys)
npm --prefix server install
npm --prefix server start
#   prints a 6-digit pair code. First fill appears after ~3 s, then one every 20 s.

# 2. glasses app
npm --prefix glasses install
npm --prefix glasses run dev          # http://localhost:5173

# 3. simulator (in another terminal, from the glasses folder)
cd glasses && npx evenhub-simulator http://localhost:5173
#   open the app's phone-side screen, enter http://localhost:8787 and the pair code
#   (or load http://localhost:5173/?server=http://localhost:8787&pair=<code>)
```

Tests and build:

```bash
npm --prefix server test              # vitest, offline
npm --prefix server run typecheck
npm --prefix glasses run build
npm --prefix glasses run pack         # -> glasses/fill-notes.ehpk
npm --prefix glasses run check:pages  # offline screen/container rule check
```

Real device: the phone cannot reach `localhost` of your computer. Use your computer's LAN address as the server address and add that address to the `network` whitelist in `glasses/app.json` before packing.

## Using the real Binance Spot testnet

1. Create testnet API keys at https://testnet.binance.vision (testnet keys only, never real-account keys).
2. Put them in a local `.env` (copy `env.example`, which has names only). Set `FILL_SOURCE=binance-testnet`.
3. The first poll is a baseline: your existing testnet history builds the average cost but raises no questions. Only fills after that start a question.

## Environment variables

| Name | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `FILL_SOURCE` | `replay` | `replay` or `binance-testnet` |
| `REASONER` | `rules` | `rules` (offline) or `openai-compatible` (falls back to rules on any error) |
| `STT` | `none` | `none` (voice answers 501) or `openai-compatible` |
| `JOURNAL` | `jsonl` | `jsonl` or `notion` (Notion also mirrors every row to the local JSONL) |
| `DAILY_LOSS_LIMIT_USD` | `200` | day loss that triggers the limit screen (0 disables) |
| `DATA_DIR` | `./data` | pair code and journal |
| `BINANCE_TESTNET_API_KEY`, `BINANCE_TESTNET_API_SECRET` | none | testnet keys (server only) |
| `BINANCE_SYMBOLS` | `BTCUSDT,ETHUSDT` | symbols to read and to cancel orders on |
| `BINANCE_POLL_MS` | `5000` | polling interval |
| `REPLAY_FIRST_DELAY_MS`, `REPLAY_INTERVAL_MS`, `REPLAY_LOOP` | `3000`, `20000`, `0` | replay pacing; `REPLAY_LOOP=1` repeats the sample |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | none | OpenAI-compatible chat completions |
| `STT_BASE_URL`, `STT_API_KEY`, `STT_MODEL` | `whisper-1` for the model | OpenAI-compatible `/audio/transcriptions` |
| `NOTION_TOKEN`, `NOTION_DATABASE_ID` | none | Notion integration |
| `FILL_NOTES_URL` | `http://localhost:8787` | used by the MCP process to reach the server |

Notion database columns: `Symbol` (title), `Time` (date), `Side` (select), `Qty` (number), `Price` (number), `PnL` (number), `Reason` (select), `Note` (text), `Source` (select).

## HTTP interface

Every route except `GET /api/health` needs `Authorization: Pair <6-digit code>`. The code is created on first start and saved in `data/pair.json`.

| Route | Purpose |
|---|---|
| `GET /api/state` | current state (mode: idle, prompt, saved, limit) |
| `GET /api/events` | Server-Sent Events: a `state` event on every change (read with fetch streaming, because `EventSource` cannot send headers) |
| `POST /api/note` | `{fillId, reasonIndex}` or `{fillId, text}` |
| `POST /api/undo` | undo the last note within 5 seconds |
| `POST /api/voice` | raw 16 kHz 16-bit mono PCM body; transcribed and saved as a note |
| `POST /api/limit/cancel-all` | cancel open testnet orders; refused unless the daily limit is reached |
| `POST /api/limit/dismiss` | "not now" for the rest of the day |
| `GET /api/pending`, `POST /api/propose` | used by the MCP tools |

## MCP (for AI agents)

```bash
npm --prefix server run mcp      # stdio server; point your MCP client at this command
```

Tools: `list_trades_with_notes`, `get_weekly_pattern`, `get_pending_prompt`, `propose_reason`.
An AI can only add a suggestion (shown as `AI: <tag>` in the list). Choosing it is a tap on the glasses.

## Design decisions worth knowing

- A note is written to the journal 5 seconds after the tap, so undo is a plain discard. Pending notes are flushed on shutdown.
- Realized PnL for Binance fills is computed with a running average cost per symbol (long-only spot, fees ignored). A sell without a known position has no PnL and counts as zero in the day total.
- Several trades of one order inside one poll are merged into one fill (volume-weighted price).
- The limit screen appears after the question for the fill that crossed the limit has been answered.
- Glyphs: `✓` is not in the G2 font, so `●` is used. The minus sign is an ASCII hyphen.
- The SDK 0.0.16 does not export `setBackgroundState` / `onBackgroundRestore` (they appear in the guide only). `glasses/src/background.ts` implements the host contract the guide describes (`window.__getStateSnapshot` / `__restoreState`) with the same function shapes.

## Money and key safety

- Testnet only. The server talks to `testnet.binance.vision` and nowhere else for trading data. There is no code path that places an order. The only write to the exchange is cancelling open testnet orders, and only after a person taps "yes" on the glasses and only when the daily limit has been reached.
- No financial advice. Reasons are labels for a motive the user chooses or writes. The AI never confirms anything.
- Keys exist only in the server's environment (`.env`, git-ignored). The glasses app and the MCP process never see them. `env.example` contains names only.
- Demo data is a fictional sample (`server/fixtures/fills.json`) or a testnet account.

## What existed before 2026-11-23

Not written for this project:

- Even Hub SDK `@evenrealities/even_hub_sdk` 0.0.16, the Even Hub CLI `@evenrealities/evenhub-cli` 0.2.0, the Even Hub simulator `@evenrealities/evenhub-simulator`, and the official Claude Code skills / guides for Even Hub.
- The Vite + TypeScript project layout and the tsconfig used for `glasses/` are adapted from a minimal hello-world Even Hub example.
- npm packages: Vite, TypeScript, vitest, tsx, `@modelcontextprotocol/sdk`, zod.
- Services and APIs: Binance Spot Testnet REST API, Notion API, the OpenAI-compatible chat and transcription API shapes, the Model Context Protocol.

Written for this project: everything else in this repository.

AI tool disclosure: fill in according to the event rules.

## Not verified yet

- Screens in the simulator, and anything on real G2 hardware (text wrapping and widths, list height, glyph rendering).
- Long-press delivery: which event kind carries it while a list is focused. The handler accepts types 9 and 10 on list, text and system events.
- The background-state hook names against a real host.
- Connection to the real Binance testnet and the real Notion API, and the real LLM / STT endpoints (only offline tests with injected `fetch`).
- Whether `http://` server addresses are accepted by the Even app WebView outside the simulator.
