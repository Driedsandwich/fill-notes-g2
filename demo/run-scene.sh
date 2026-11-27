#!/bin/bash
# run-scene.sh <script.json> <outDir>
# Starts the Fill Notes server, the glasses app (vite) and the Even Hub simulator, runs capture.mjs,
# then stops ONLY the processes it started (by PID / process group recorded in <outDir>/pids/).
# Env overrides: SIM_JS, SERVER_PORT, APP_PORT, SERVER_FIRST_DELAY_MS (default 9000), REPLAY_INTERVAL_MS (default 60000)
set -u
set -m   # every background job gets its own process group (pgid == pid)

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SCENE_DIR="$(cd "$(dirname "${1:?usage: run-scene.sh <script.json> <outDir>}")" && pwd)" || exit 2
SCRIPT="$SCENE_DIR/$(basename "$1")"
OUT="${2:?usage: run-scene.sh <script.json> <outDir>}"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
OUT="$(node "$HERE/capture.mjs" "$SCRIPT" "$OUT" --validate-only)" || exit $?
OUT="${OUT%/.}"
mkdir -p "$OUT" || exit 2

# Simulator: SIM_JS (path to the package's bin/index.js), else the `evenhub-simulator` command on PATH
# (npm i -g @evenrealities/evenhub-simulator).
SIM_JS="${SIM_JS:-}"
if [ -n "$SIM_JS" ]; then
  SIM_CMD=(node "$SIM_JS")
else
  SIM_BIN="$(command -v evenhub-simulator || true)"
  [ -n "$SIM_BIN" ] || { echo "simulator not found: set SIM_JS to @evenrealities/evenhub-simulator/bin/index.js, or install it so evenhub-simulator is on PATH" >&2; exit 2; }
  SIM_CMD=("$SIM_BIN")
fi
# Optional: SIM_WINDOW_POS="x,y" moves the simulator window there (e.g. onto a spare display while recording).
SIM_WINDOW_POS="${SIM_WINDOW_POS:-}"
case "$SIM_WINDOW_POS" in "" | [0-9-]*,[0-9-]*) ;; *) echo "SIM_WINDOW_POS must look like x,y" >&2; exit 2 ;; esac
SERVER_PORT="${SERVER_PORT:-8787}"
APP_PORT="${APP_PORT:-5173}"
AUTO_PORT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).automationPort??9898)' "$SCRIPT")"
LEAD_S="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).serverLeadSec??1.5)' "$SCRIPT")"
FIRST_DELAY_MS="${SERVER_FIRST_DELAY_MS:-9000}"
INTERVAL_MS="${REPLAY_INTERVAL_MS:-60000}"
export PATH="$PATH:/opt/homebrew/bin"

listeners() { lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | tail -n +2 | wc -l | tr -d ' '; }

# Refuse to start if a port is already taken (we never kill by port).
for p in "$SERVER_PORT" "$APP_PORT" "$AUTO_PORT"; do
  if [ "$(listeners "$p")" != "0" ]; then
    echo "port $p is already in use by another process; nothing started, nothing stopped." >&2
    exit 3
  fi
done

mkdir -p "$OUT/pids" "$OUT/logs" "$OUT/data"
: > "$OUT/pids/all.txt"

tree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do tree "$c"; done; echo "$1"; }

stop_one() {  # stop_one <name>
  local f="$OUT/pids/$1.pid" pid pids p i alive
  [ -f "$f" ] || return 0
  pid="$(cat "$f")"
  pids="$(tree "$pid")"
  if [ "$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')" = "$pid" ]; then kill -TERM -- "-$pid" 2>/dev/null; fi
  for p in $pids; do kill -TERM "$p" 2>/dev/null; done
  for i in 1 2 3 4 5 6 7 8 9 10; do
    alive=0
    for p in $pids; do kill -0 "$p" 2>/dev/null && alive=1; done
    [ $alive = 0 ] && break
    sleep 0.5
  done
  for p in $pids; do
    if kill -0 "$p" 2>/dev/null; then kill -KILL "$p" 2>/dev/null; echo "KILL needed for $1 pid $p" >> "$OUT/pids/all.txt"; fi
  done
  echo "stopped $1 (pid $pid; tree: $(echo $pids))" >> "$OUT/pids/all.txt"
}

cleanup() {
  trap - EXIT INT TERM
  stop_one simulator; stop_one vite; stop_one server
  sleep 1
  echo "{\"afterStop\":{\"$SERVER_PORT\":$(listeners "$SERVER_PORT"),\"$APP_PORT\":$(listeners "$APP_PORT"),\"$AUTO_PORT\":$(listeners "$AUTO_PORT")}}" > "$OUT/ports_after.json"
  cat "$OUT/ports_after.json"
  if [ -f "$OUT/report.json" ]; then
    node -e '
      const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1]));
      r.listenersAfterStop=JSON.parse(fs.readFileSync(process.argv[2])).afterStop;
      r.stopLog=fs.readFileSync(process.argv[3],"utf8").trim().split("\n");
      fs.writeFileSync(process.argv[1],JSON.stringify(r,null,2))' "$OUT/report.json" "$OUT/ports_after.json" "$OUT/pids/all.txt"
  fi
}
trap cleanup EXIT INT TERM

wait_http() {  # wait_http <url> <seconds>
  local i n=$(( $2 * 2 ))
  for ((i = 0; i < n; i++)); do curl -fsS -m 2 -o /dev/null "$1" 2>/dev/null && return 0; sleep 0.5; done
  return 1
}

stage() { echo "$(node -e 'console.log(Date.now())') $*" >> "$OUT/logs/stages.log"; }
: > "$OUT/logs/stages.log"

# The server starts LAST so the first fill question lands at a known time: SERVER_FIRST_DELAY_MS after the
# server starts. (The app retries the server every 3 s and picks up the state when it connects.)
# Pairing code is written beforehand so the app URL can carry it. Journal and pairing live in <outDir>/data.
PAIR="$(printf '%06d' $(( (RANDOM * 32768 + RANDOM) % 1000000 )))"
echo "{\"code\":\"$PAIR\",\"createdAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"}" > "$OUT/data/pair.json"

# 1. glasses app
npm --prefix "$ROOT/glasses" run dev -- --port "$APP_PORT" --strictPort --host 127.0.0.1 > "$OUT/logs/vite.log" 2>&1 &
echo $! > "$OUT/pids/vite.pid"
wait_http "http://127.0.0.1:$APP_PORT/" 30 || { echo "vite did not come up (see $OUT/logs/vite.log)" >&2; exit 4; }
stage "vite up"

# 2. simulator
URL="http://127.0.0.1:$APP_PORT/?server=http://127.0.0.1:$SERVER_PORT&pair=$PAIR"
"${SIM_CMD[@]}" "$URL" --automation-port "$AUTO_PORT" --no-glow > "$OUT/logs/simulator.log" 2>&1 &
echo $! > "$OUT/pids/simulator.pid"
wait_http "http://127.0.0.1:$AUTO_PORT/api/ping" 30 || { echo "simulator did not come up (see $OUT/logs/simulator.log)" >&2; exit 4; }
stage "simulator ping ok"

# 3. optional: move the simulator window to SIM_WINDOW_POS (try twice, record positions and errors)
#    Capture does not depend on the window position (frames come from the automation port).
if [ -n "$SIM_WINDOW_POS" ]; then
pos_get() { osascript -e 'tell application "System Events" to tell process "evenhub-simulator" to get position of window 1' 2>&1 | tr -d ' \n'; }
pos_set() { osascript -e "tell application \"System Events\" to tell process \"evenhub-simulator\" to set position of every window to {${SIM_WINDOW_POS}}" 2>&1; }
POS_BEFORE=""
for i in $(seq 1 20); do
  POS_BEFORE="$(pos_get)"
  case "$POS_BEFORE" in [0-9-]*,[0-9-]*) break ;; esac
  sleep 0.5
done
ERR1="$(pos_set)"; POS_AFTER1="$(pos_get)"
sleep 1
ERR2="$(pos_set)"; POS_AFTER2="$(pos_get)"
TARGET="$SIM_WINDOW_POS" POS_BEFORE="$POS_BEFORE" ERR1="$ERR1" ERR2="$ERR2" POS_AFTER1="$POS_AFTER1" POS_AFTER2="$POS_AFTER2" node -e '
  const e=process.env; const target=e.TARGET.replace(/\s/g,"");
  const ok=e.POS_AFTER2===target;
  require("fs").writeFileSync(process.argv[1],JSON.stringify({target,before:e.POS_BEFORE,attempt1:{error:e.ERR1||null,after:e.POS_AFTER1},attempt2:{error:e.ERR2||null,after:e.POS_AFTER2},movedToTarget:ok},null,2))' "$OUT/window.json"
stage "window moved (see window.json)"
else
  stage "window not moved (SIM_WINDOW_POS unset)"
fi

# 4. server
S_EPOCH_MS="$(node -e 'console.log(Date.now())')"
FILL_SOURCE=replay REASONER=rules STT=none JOURNAL=jsonl DATA_DIR="$OUT/data" PORT="$SERVER_PORT" \
  REPLAY_FIRST_DELAY_MS="$FIRST_DELAY_MS" REPLAY_INTERVAL_MS="$INTERVAL_MS" \
  npm --prefix "$ROOT/server" start > "$OUT/logs/server.log" 2>&1 &
echo $! > "$OUT/pids/server.pid"
wait_http "http://127.0.0.1:$SERVER_PORT/api/health" 30 || { echo "server did not come up (see $OUT/logs/server.log)" >&2; exit 4; }
H_EPOCH_MS="$(node -e 'console.log(Date.now())')"
stage "server health ok (server started at $S_EPOCH_MS, first fill planned at +${FIRST_DELAY_MS} ms of engine start)"

# 5. capture: start so that the first fill question appears about LEAD_S after t0 (counted from the first successful /api/health poll, +-0.5 s)
START_AT=$(( H_EPOCH_MS + FIRST_DELAY_MS - $(node -e 'console.log(Math.round(process.argv[1]*1000))' "$LEAD_S") ))
node "$HERE/capture.mjs" "$SCRIPT" "$OUT" --start-at "$START_AT" --window-json "$OUT/window.json"
RC=$?
echo "capture exit code: $RC"
exit $RC
