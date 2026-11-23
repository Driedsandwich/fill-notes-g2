"""Local speech-to-text for Fill Notes (Apple Silicon): prints the transcript of one WAV file.

Usage: STT=local-command STT_COMMAND=python3 STT_ARGS="scripts/stt_mlx_whisper.py" npm start
Needs `pip install mlx-whisper`. The model is downloaded once from Hugging Face and then runs offline.
"""
import os
import sys

import mlx_whisper

wav = sys.argv[-1]
model = os.environ.get("FILLNOTES_WHISPER_MODEL", "mlx-community/whisper-base.en-mlx")
result = mlx_whisper.transcribe(wav, path_or_hf_repo=model, language="en", condition_on_previous_text=False, temperature=0.0)
print((result.get("text") or "").strip())
