import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FetchLike, Transcriber } from './types.ts'

/** Wrap raw PCM (16 kHz, 16-bit little-endian, mono) in a WAV container. */
export function pcmToWav(pcm: Uint8Array, sampleRate = 16000, channels = 1, bits = 16): Uint8Array {
  const header = Buffer.alloc(44)
  const byteRate = (sampleRate * channels * bits) / 8
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE((channels * bits) / 8, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

export interface SttOptions {
  baseUrl: string
  apiKey: string
  model: string
  fetchImpl?: FetchLike
}

export function openAICompatibleTranscriber(opts: SttOptions): Transcriber {
  const doFetch: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i))
  return async (pcm) => {
    const form = new FormData()
    form.append('model', opts.model)
    form.append('file', new Blob([Buffer.from(pcmToWav(pcm))], { type: 'audio/wav' }), 'voice.wav')
    const res = await doFetch(`${opts.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.apiKey}` },
      body: form,
    })
    if (!res.ok) throw new Error(`STT HTTP ${res.status}`)
    const json = (await res.json()) as { text?: string }
    return (json.text ?? '').trim()
  }
}

export interface LocalCommandOptions {
  /** Program to run, e.g. `python3`. */
  command: string
  /** Extra arguments; the WAV path is appended last. */
  args?: string[]
  timeoutMs?: number
}

/**
 * Speech-to-text on this machine: writes the clip to a temp WAV, runs `command ...args <wav>`
 * and takes stdout as the text. Audio never leaves the computer running the server.
 */
export function localCommandTranscriber(opts: LocalCommandOptions): Transcriber {
  return async (pcm) => {
    const dir = await mkdtemp(join(tmpdir(), 'fillnotes-stt-'))
    const wav = join(dir, 'voice.wav')
    try {
      await writeFile(wav, pcmToWav(pcm))
      const out = await new Promise<string>((resolve, reject) => {
        execFile(opts.command, [...(opts.args ?? []), wav], { timeout: opts.timeoutMs ?? 60000, maxBuffer: 1 << 20 }, (err, stdout) =>
          err ? reject(new Error(`STT command failed: ${err.message}`)) : resolve(String(stdout)),
        )
      })
      return out.trim()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}

export interface LocalHttpOptions {
  baseUrl: string
  fetchImpl?: FetchLike
}

/** Speech-to-text through the local server in scripts/stt_server.py (keeps the model warm; 127.0.0.1 only). */
export function localHttpTranscriber(opts: LocalHttpOptions): Transcriber {
  const doFetch: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i))
  return async (pcm) => {
    const res = await doFetch(`${opts.baseUrl.replace(/\/+$/, '')}/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: Buffer.from(pcmToWav(pcm)),
    })
    if (!res.ok) throw new Error(`STT HTTP ${res.status}`)
    const json = (await res.json()) as { text?: string }
    return (json.text ?? '').trim()
  }
}
