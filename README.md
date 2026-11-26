# Fill Notes

Ask "Why?" on your Even Realities G2 smart glasses (G2) the moment a crypto **testnet** trade fills, and keep the answer.

Demo video: https://youtu.be/yMBfs9B9D-c · Verification status: see 'Verification status' below · Run it in replay mode (no keys, no network): see Quick start.

TESTNET ONLY. No real money is touched. Nothing here is trading advice: the reason tags describe a motive the trader chooses, they never say what to do.

## What it does

Fill Notes is a G2 trade-journaling prototype that asks for a reason while a trade is still fresh.

A Binance Spot testnet fill (or a synthetic fill used for demonstration) opens a short prompt on the glasses, for example `SELL 0.5 ETH @ 3,412 +$36.00` and `Why?`. Three rule-based reason tags appear. Swipe to select one and tap to save, or hold to dictate a short reason. An optional AI suggestion can add another tag; the wearer makes the choice.

A five-second undo window comes before recording. Every note is written to a local JSON Lines (JSONL) file (`data/journal.jsonl`). With `JOURNAL=notion` and a Notion token and database id set, each note is also written to a Notion table; the local file is written first, so a Notion outage does not lose a note.

When realized daily losses reach a limit set by the user, the app asks whether to cancel all open testnet orders. Cancellation requires a confirming tap on the glasses. Filled positions remain, and nothing is sold.

## Who it is for

People making short-term crypto trades who want to record their reasons right after a fill and revisit them later. The reason is clear at the moment of execution but often forgotten by a weekend review, and opening a phone to write a journal entry is one more task at that moment. Fill Notes offers a brief choice on the glasses instead.

## How it works

MCP below means Model Context Protocol, a standard way for AI agents to call tools.

```
 Binance Spot TESTNET            (or)  fixtures/fills.json
  GET /api/v3/myTrades  (signed)        synthetic fills (replay)
              \                         /
               v                       v
        +---------------------------------------+
        |  server  (Node 22, TypeScript)        |   keys live only here
        |  fill source -> reasoner (3 reasons)  |
        |  engine: prompt / saved(5s undo) /    |--> data/journal.jsonl
        |          daily-loss limit / pairing   |--> Notion DB (optional)
        |  HTTP + SSE        MCP (stdio)        |<-- LLM / STT (optional)
        +-----------+---------------+-----------+
                    |               |
        phone WebView (Even app)    AI agents (Claude, etc.)
        glasses/  (Vite + Even Hub SDK)   list_trades_with_notes, get_weekly_pattern,
          -> 576x288 screens on the G2     get_pending_prompt, propose_reason
```

- Glasses app and server: the app uses the Even Hub SDK, Vite and TypeScript, runs in a WebView inside the Even Realities App, and pairs with its own server through a six-digit code.
- Reason choices: rules pick three tags from take-profit, stop-loss, scale-in, scale-out, breakout, dip-buy and rebalance. An optional OpenAI-compatible LLM can add one tag suggestion (`AI: <tag>`). It never recommends trades.
- Voice: speech-to-text is your own: a local Whisper server on the same machine (`server/scripts/stt_server.py`, small English model) or any OpenAI-compatible endpoint.
- Agent tools (MCP, Model Context Protocol, for AI agents): an agent can read notes, see weekly patterns, see the pending prompt and propose a reason. It cannot choose for the wearer.

Glasses screens (green, text only, no font control):

1. Waiting: `FILL NOTES · TESTNET`, notes today, day PnL (profit and loss), a `━━━───` bar against the loss limit.
2. Fill question: the fill line, `Why?`, the reason list, `TESTNET · Tap = save · Hold = voice`.
3. Saved: `Saved ● <reason>` and `Tap to undo (5s)`.
4. Day limit: `Day PnL -$216.61 · limit $200 reached`, `Cancel all open orders?`, `Filled positions stay. Nothing is sold.` Tap = yes, swipe = not now.

## Money and data safety

- Testnet only. The server talks to `testnet.binance.vision` and nowhere else for trading data. There is no code path that places an order. The only exchange write is cancelling open testnet orders, after the daily limit is reached and the wearer confirms on the glasses. Filled positions are not closed and nothing is sold.
- No financial advice. Reason tags describe the motive the user chooses or writes.
- Keys stay on your own server (`.env`, git-ignored). The glasses app, the LLM and the MCP process never see them. `env.example` has names only. A multi-user version would keep each user's exchange keys on a server that user runs, not on a shared service.
- Demonstrations use synthetic fills (`server/fixtures/fills.json`) or a testnet account only. Never commit API keys or secrets.

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
npm --prefix glasses run pack         # -> glasses/fill-notes.ehpk (.ehpk = Even Hub app package)
npm --prefix glasses run check:pages  # offline screen/container rule check
```

Environment variables and the HTTP interface are listed in Reference at the end.

Real device: the phone cannot reach `localhost` of your computer. Use your computer's LAN address as the server address and add that address to the `network` whitelist in `glasses/app.json` before packing.

## Using the real Binance Spot testnet

1. Create testnet API keys at https://testnet.binance.vision (testnet keys only, never real-account keys).
2. Put them in a local `.env` (copy `env.example`, which has names only). Set `FILL_SOURCE=binance-testnet`.
3. The first poll is a baseline: your existing testnet history builds the average cost but raises no questions. Only fills after that start a question.

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

## What existed before the build period (started 2026-11-23)

Not written for this project:

- Even Hub SDK `@evenrealities/even_hub_sdk` 0.0.16, the Even Hub CLI `@evenrealities/evenhub-cli` 0.2.0, the Even Hub simulator `@evenrealities/evenhub-simulator`, and the official Claude Code skills / guides for Even Hub.
- The Vite + TypeScript project layout and the tsconfig used for `glasses/` are adapted from a minimal hello-world Even Hub example.
- npm packages: Vite, TypeScript, vitest, tsx, `@modelcontextprotocol/sdk`, zod.
- Services and APIs: Binance Spot Testnet REST API, Notion API, the OpenAI-compatible chat and transcription API shapes, the Model Context Protocol.

Written for this project: everything else in this repository.

## How AI tools were used

AI assistants did the building: Claude Code wrote the code, tests and documentation; ChatGPT wrote first drafts of the description and the demo script; Codex made design mockups. The entrant chose the project's subject and the glasses screen layout from options the AI proposed, and submits the work.

## Verification status (25 November 2026)

Checked on the developer's machine:

- `npm --prefix server test`: 51 tests pass. Glasses app typecheck, build, `check:pages` and `.ehpk` packing pass.
- Even Hub simulator, driven through its automation port with synthetic fills: waiting -> fill question -> select -> tap -> `Saved ● breakout` -> waiting; and the day-limit screen after 10 synthetic fills (day PnL -$216.61, limit $200) -> tap -> `Stopped for today (3 orders cancelled)`. The cancelled orders are the replay fixture's fictional open orders, not testnet orders.
- MCP: all four tools called end to end against the replay server (a proposed `AI:` tag chosen by tap is recorded and shows in the weekly pattern).
- Voice: a Mac-generated English phrase ("took profit at resistance") transcribed correctly by the local small Whisper model in about 3 seconds. This was not the G2 microphone.

Not verified yet:

- The real Binance Spot testnet and the real Notion API (only offline tests with injected `fetch`), and real LLM / STT endpoints.
- Anything on real G2 hardware: receiving a long press, display width and glyph shapes, list height, the microphone.
- Cancelling real open orders on the Binance Spot testnet (the only exchange write).
- The background-state hook names (`window.__getStateSnapshot` / `__restoreState`) against a real host.
- Whether `http://` server addresses are accepted by the Even app WebView outside the simulator.

## Reference

### Environment variables

| Name | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `FILL_SOURCE` | `replay` | `replay` or `binance-testnet` |
| `REASONER` | `rules` | `rules` (offline) or `openai-compatible` (falls back to rules on any error) |
| `STT` | `none` | `none` (voice answers 501), `openai-compatible`, `local-http` (POSTs WAV to `STT_BASE_URL`, default `http://127.0.0.1:8796`, e.g. `server/scripts/stt_server.py`) or `local-command` (`STT_COMMAND` + `STT_ARGS`, reads the transcript from stdout) |
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

### HTTP interface

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

### About this repository's history

This public repository is a copy of the private development repository, with the same commits, authors, dates and messages. In the copy, two lines in older versions of the demo files were changed: a path on the developer's machine in the demo recording script and an internal draft label in a demo script note. This changes the commit IDs from the first affected commit onward; the current files are identical to the development repository.
