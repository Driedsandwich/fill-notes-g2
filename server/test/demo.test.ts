import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, it } from 'vitest'
import { rmTmp, tmpDir } from './helpers.ts'

const dir = tmpDir()
afterAll(() => rmTmp(dir))

const demo = fileURLToPath(new URL('../../demo/', import.meta.url))
const sceneNames = new URL('scene-names.mjs', new URL('../../demo/', import.meta.url)).href

it.each([
  ['mark_1-OK', true],
  ['../x', false],
  ['a/b', false],
  ['', false],
  ['a'.repeat(65), false],
] as const)('validates scene mark name %j (valid: %s)', async (name, valid) => {
  const { validateSceneNames } = await import(sceneNames) as { validateSceneNames: (scene: unknown) => void }
  const validate = () => validateSceneNames({ marks: [{ name }] })
  if (valid) expect(validate).not.toThrow()
  else expect(validate).toThrow('invalid scene mark name')
})

it.each([
  ['capture', process.execPath, 'capture.mjs'],
  ['scene runner', 'bash', 'run-scene.sh'],
] as const)('%s rejects an invalid scene before changing output', (_, command, script) => {
  const root = fs.mkdtempSync(path.join(dir, 'scene-'))
  const scene = path.join(root, 'scene.json')
  const out = path.join(root, 'out')
  const frames = path.join(out, 'frames')
  fs.mkdirSync(frames, { recursive: true })
  fs.writeFileSync(path.join(frames, 'keep.png'), 'existing frame')
  fs.writeFileSync(scene, JSON.stringify({
    steps: [{ at: 1, action: 'end' }],
    marks: [{ at: 0, name: 'valid' }, { at: 1, name: '../../outside' }],
  }))

  const result = spawnSync(command, [path.join(demo, script), scene, out], { encoding: 'utf8', timeout: 1500 })

  expect(result.status).toBe(2)
  expect(result.stderr.trim().split('\n')).toEqual([expect.stringContaining('invalid scene mark name')])
  expect(fs.readdirSync(root).sort()).toEqual(['out', 'scene.json'])
  expect(fs.readdirSync(out)).toEqual(['frames'])
  expect(fs.readdirSync(frames)).toEqual(['keep.png'])
})
