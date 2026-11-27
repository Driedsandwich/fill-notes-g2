import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
}

/** Load the saved pairing code from `<dir>/pair.json`, or create and save a new one. */
export function loadOrCreatePairCode(dir: string): string {
  const file = path.join(dir, 'pair.json')
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { code?: string }
    if (typeof j.code === 'string' && /^\d{6}$/.test(j.code)) return j.code
  } catch {
    // fall through and create
  }
  const code = generateCode()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ code, createdAt: new Date().toISOString() }), { mode: 0o600 })
  return code
}

export function readPairHeader(header: string | undefined): string | undefined {
  return /^Pair\s+(\d{6})$/.exec(header?.trim() ?? '')?.[1]
}

/** Accepts `Authorization: Pair 123456`. Constant-time compare. */
export function checkPairHeader(header: string | undefined, code: string): boolean {
  const supplied = readPairHeader(header)
  if (!supplied) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(code)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
