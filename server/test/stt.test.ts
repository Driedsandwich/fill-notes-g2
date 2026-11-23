import { describe, expect, it } from 'vitest'
import { openAICompatibleTranscriber, pcmToWav } from '../src/stt.ts'

describe('pcmToWav', () => {
  it('writes a 44-byte header for 16 kHz 16-bit mono', () => {
    const pcm = new Uint8Array(3200)
    const wav = Buffer.from(pcmToWav(pcm))
    expect(wav.length).toBe(44 + 3200)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt32LE(24)).toBe(16000)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(wav.readUInt32LE(28)).toBe(32000) // byte rate
    expect(wav.readUInt32LE(40)).toBe(3200)
  })
})

describe('openAICompatibleTranscriber', () => {
  it('posts multipart to /audio/transcriptions and returns trimmed text', async () => {
    let seen = ''
    let auth: string | null = null
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen = url
      auth = new Headers(init?.headers).get('authorization')
      expect(init?.body).toBeInstanceOf(FormData)
      return new Response(JSON.stringify({ text: ' hello ' }), { status: 200 })
    }
    const t = openAICompatibleTranscriber({ baseUrl: 'https://stt.invalid/v1/', apiKey: 'test-key', model: 'm', fetchImpl })!
    expect(await t(new Uint8Array(100))).toBe('hello')
    expect(seen).toBe('https://stt.invalid/v1/audio/transcriptions')
    expect(auth).toBe('Bearer test-key')
  })
})

import { localCommandTranscriber, localHttpTranscriber } from '../src/stt.ts'

describe('stt: local command', () => {
  it('passes a WAV file to the command and returns its stdout', async () => {
    // `node -e` prints the size of the file it was given: 44-byte header + 3200 bytes of PCM
    const t = localCommandTranscriber({ command: process.execPath, args: ['-e', 'console.log("bytes", require("fs").statSync(process.argv.at(-1)).size)'] })
    expect(await t!(new Uint8Array(3200))).toBe('bytes 3244')
  })

  it('reports a failing command as an error', async () => {
    const t = localCommandTranscriber({ command: process.execPath, args: ['-e', 'process.exit(3)'] })
    await expect(t!(new Uint8Array(10))).rejects.toThrow(/STT command failed/)
  })
})

describe('stt: local http server', () => {
  it('posts a WAV body to /transcribe and returns the text', async () => {
    let seen: { url: string; len: number; type: string } | null = null
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const body = init!.body as Buffer
      seen = { url, len: body.length, type: String((init!.headers as Record<string, string>)['content-type']) }
      return new Response(JSON.stringify({ text: ' took profit at resistance ' }), { status: 200 })
    }
    const t = localHttpTranscriber({ baseUrl: 'http://127.0.0.1:8796/', fetchImpl })
    expect(await t!(new Uint8Array(3200))).toBe('took profit at resistance')
    expect(seen).toEqual({ url: 'http://127.0.0.1:8796/transcribe', len: 3244, type: 'audio/wav' })
  })
})
