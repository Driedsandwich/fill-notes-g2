# demo/ - record the glasses screen from the Even G2 simulator

Drives `@evenrealities/evenhub-simulator` through its automation HTTP port with a JSON script, takes a
screenshot of the 576x288 glasses display at a fixed frame rate, and writes an mp4 plus still images.
Used for the "glasses screen" layer of the demo video.

## Quick start

```bash
demo/run-scene.sh demo/fill-notes-scene1.json /path/to/output-dir
```

`run-scene.sh` starts the glasses app (vite, port 5173), the simulator (automation port from the script, 9898),
optionally moves the simulator window (`SIM_WINDOW_POS=x,y`, e.g. onto a spare display), then starts the Fill Notes server
(port 8787, replay mode, fictional fills), runs `capture.mjs`, and stops only the processes it started
(PIDs and process groups are kept in `<out>/pids/`; it never kills by port). It refuses to start when
8787, 5173 or the automation port is already listening.

Needs: Node 22, ffmpeg/ffprobe, macOS Accessibility permission for `osascript` (only with `SIM_WINDOW_POS`).
The simulator comes from `SIM_JS` (path to `@evenrealities/evenhub-simulator/bin/index.js`) or the `evenhub-simulator` command on PATH (`npm i -g @evenrealities/evenhub-simulator`).
The server journal and pairing code go to `<out>/data/`, not into the repo.

## Script format

```json
{
  "automationPort": 9898,
  "fps": 6,
  "scale": 2,
  "serverLeadSec": 1.5,
  "steps": [
    { "at": 4.5, "action": "down" },
    { "at": 6.0, "action": "click" },
    { "at": 20.0, "action": "end" }
  ],
  "marks": [ { "at": 3.5, "name": "prompt" } ]
}
```

- Times are seconds from the start of capture. `action`: `wait` (no-op), `up`, `down`, `click`, `double_click`, `end` (stop).
  `long_press` is accepted but avoid it in scripts: it opens the Mac microphone.
- `fps`: capture rate and mp4 frame rate. `scale`: integer upscaling of the 576x288 picture (nearest neighbour), default 1.
- `serverLeadSec`: run-scene.sh starts capture about this many seconds before the app's first fill question appears
  (server first fill delay is `SERVER_FIRST_DELAY_MS`, default 9000; later fills every `REPLAY_INTERVAL_MS`, default 60000).
- Tip: in the "saved" screen a click means undo (5 s window). Do not click while it is shown.

## Output

- `scene.mp4` - H.264, yuv420p, transparent glasses background composited on black.
- `frames/frame_00000.png ...` - raw RGBA screenshots, one per frame slot (a slot that was missed repeats the previous picture).
- `marks/<name>.png` - the picture at each mark time, on black.
- `report.json` - frames captured/repeated/failed, screenshot timing, each input with its HTTP reply and whether the picture changed
  within 1 s, list of picture changes, marks, ffprobe result, window position, listeners left after stop.
- `console.json` - simulator console log. `window.json`, `logs/` - run-scene.sh details.

`capture.mjs` can also be used alone against a running simulator:
`node demo/capture.mjs script.json out-dir [--start-at <epochMs>] [--window-json file]`.
