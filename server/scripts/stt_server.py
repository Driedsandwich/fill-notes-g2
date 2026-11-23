"""Local speech-to-text server for Fill Notes (Apple Silicon, mlx-whisper). Keeps the model in memory.

POST /transcribe with a WAV body -> {"text": "..."}. Listens on 127.0.0.1 only, so audio never leaves the machine.
Run:  python3 scripts/stt_server.py            (port 8796, env FILLNOTES_STT_PORT to change)
Then: STT=local-http STT_BASE_URL=http://127.0.0.1:8796 npm start
"""
import json
import os
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import mlx_whisper

MODEL = os.environ.get("FILLNOTES_WHISPER_MODEL", "mlx-community/whisper-base.en-mlx")
PORT = int(os.environ.get("FILLNOTES_STT_PORT", "8796"))
MAX_BYTES = 16000 * 2 * 60 + 44  # one minute of 16 kHz 16-bit mono


def transcribe(path: str) -> str:
    r = mlx_whisper.transcribe(path, path_or_hf_repo=MODEL, language="en", condition_on_previous_text=False, temperature=0.0)
    return (r.get("text") or "").strip()


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            return self._send(200, {"ok": True, "model": MODEL})
        self._send(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/transcribe":
            return self._send(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 44 or n > MAX_BYTES:
            return self._send(400, {"error": "send a WAV body up to one minute"})
        data = self.rfile.read(n)
        with tempfile.NamedTemporaryFile(suffix=".wav") as f:
            f.write(data)
            f.flush()
            t0 = time.time()
            text = transcribe(f.name)
        self._send(200, {"text": text, "seconds": round(time.time() - t0, 2)})

    def log_message(self, fmt, *args):  # keep transcripts out of logs
        pass


if __name__ == "__main__":
    # Warm up once so the first real request is fast.
    import struct, wave
    with tempfile.NamedTemporaryFile(suffix=".wav") as f:
        with wave.open(f.name, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
            w.writeframes(struct.pack("<h", 0) * 8000)
        transcribe(f.name)
    print(f"stt server ready on 127.0.0.1:{PORT} model={MODEL}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
