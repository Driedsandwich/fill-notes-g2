import {
  AudioInputSource,
  OsEventTypeList,
  TextContainerUpgrade,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import { Api, ApiError, type ServerState, type Settings } from './api.ts'
import { onBackgroundRestore, setBackgroundState } from './background.ts'
import { buildScreen, toCreate, toRebuild, type Ctx, type Screen } from './screens.ts'
import type { SettingsUi } from './settings.ts'

const MAX_PCM_BYTES = 960_000 // 30 s of 16 kHz 16-bit mono
const MIN_PCM_BYTES = 3_200 // 0.1 s
const CALL_TIMEOUT_MS = 8_000

export interface App {
  updateSettings(s: Settings): void
  dispose(): void
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('bridge call timed out')), ms))])
}

export function startApp(bridge: EvenAppBridge, initial: Settings, ui: SettingsUi): App {
  const api = new Api(initial)
  let state: ServerState | null = null
  let online = false
  let flash = ''
  let flashTimer: ReturnType<typeof setTimeout> | null = null
  let created = false
  let last: Screen | null = null
  let stopSub: (() => void) | null = null

  let recording = false
  let chunks: Uint8Array[] = []
  let recBytes = 0

  // Everything shown must survive a background trip: the last state and the connection flag are replayed after restore.
  setBackgroundState('fillnotes', () => ({ state: state as unknown as Record<string, unknown> | null, flash }))
  onBackgroundRestore('fillnotes', (saved) => {
    state = (saved.state as ServerState | null) ?? state
    scheduleRender()
  })

  // --- serialized bridge access (concurrent calls can break the BLE link) ---
  let chain: Promise<unknown> = Promise.resolve()
  function enqueue<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const run = chain.then(() => withTimeout(fn(), CALL_TIMEOUT_MS)).catch((e: Error) => {
      console.error('[bridge]', e.message)
      return undefined
    })
    chain = run
    return run as Promise<T | undefined>
  }

  let renderQueued = false
  function scheduleRender(): void {
    if (renderQueued) return
    renderQueued = true
    void enqueue(async () => {
      renderQueued = false
      await render()
    })
  }

  function ctx(): Ctx {
    return { configured: api.configured, online, flash }
  }

  async function render(): Promise<void> {
    const sc = buildScreen(state, ctx())
    if (!created) {
      const r = await bridge.createStartUpPageContainer(toCreate(sc))
      if (r !== 0) {
        console.error('[render] createStartUpPageContainer result', r)
        return
      }
      created = true
      last = sc
      return
    }
    if (last && last.layout === sc.layout && last.kind === sc.kind) {
      // same containers: update only the text that changed, no flicker
      for (let i = 0; i < sc.text.length; i++) {
        const t = sc.text[i]!
        if (last.text[i]?.content === t.content) continue
        await bridge.textContainerUpgrade(
          new TextContainerUpgrade({ containerID: t.containerID, containerName: t.containerName, contentOffset: 0, contentLength: 0, content: t.content }),
        )
      }
      last = sc
      return
    }
    await bridge.rebuildPageContainer(toRebuild(sc))
    last = sc
  }

  function setFlash(msg: string, ms = 2500): void {
    flash = msg
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = msg ? setTimeout(() => setFlash(''), ms) : null
    scheduleRender()
  }

  function accept(s: ServerState): void {
    state = s
    scheduleRender()
  }

  // --- server link ---
  function connect(): void {
    stopSub?.()
    stopSub = null
    if (!api.configured) {
      online = false
      ui.status('Enter the server address and the 6-digit pair code.')
      scheduleRender()
      return
    }
    stopSub = api.subscribe(
      (s) => accept(s),
      (ok) => {
        online = ok
        ui.status(ok ? 'Connected to the server.' : 'Server unreachable. Retrying...', ok ? 'ok' : 'err')
        scheduleRender()
      },
    )
  }

  async function guarded<T>(fn: () => Promise<T>, fail: string): Promise<T | undefined> {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setFlash('Wrong pair code')
      else if (e instanceof ApiError && e.status === 409) setFlash(e.message.slice(0, 40))
      else setFlash(fail)
      return undefined
    }
  }

  // --- actions ---
  async function choose(index: number): Promise<void> {
    const p = state?.prompt
    if (!p) return
    const s = await guarded(() => api.note(p.fillId, index), 'Save failed')
    if (s) accept(s)
  }

  async function undo(): Promise<void> {
    const s = await guarded(() => api.undo(), 'Too late to undo')
    if (s) accept(s)
  }

  async function cancelAll(): Promise<void> {
    const r = await guarded(() => api.cancelAll(), 'Cancel failed')
    if (r) accept(r.state)
  }

  async function dismissLimit(): Promise<void> {
    const s = await guarded(() => api.dismissLimit(), 'Failed')
    if (s) accept(s)
  }

  async function startRecording(): Promise<void> {
    if (recording || state?.mode !== 'prompt') return
    chunks = []
    recBytes = 0
    recording = true
    const ok = await bridge.audioControl(true, AudioInputSource.Glasses)
    if (!ok) {
      recording = false
      setFlash('Mic unavailable')
      return
    }
    setFlash('Listening... release to send', 30_000)
  }

  async function stopRecording(): Promise<void> {
    if (!recording) return
    recording = false
    await bridge.audioControl(false)
    const total = new Uint8Array(recBytes) // concatenated PCM
    let off = 0
    for (const c of chunks) {
      total.set(c, off)
      off += c.length
    }
    chunks = []
    recBytes = 0
    if (total.length < MIN_PCM_BYTES) return setFlash('Too short, hold longer')
    setFlash('Transcribing...', 20_000)
    try {
      const r = await api.voice(total, state?.prompt?.fillId)
      accept(r.state)
      setFlash('')
    } catch (e) {
      if (e instanceof ApiError && e.status === 501) setFlash('Voice is off on the server')
      else if (e instanceof ApiError && e.status === 409) setFlash('Nothing recognized')
      else setFlash('Voice failed')
    }
  }

  function stopHardware(): void {
    if (recording) {
      recording = false
      chunks = []
      void bridge.audioControl(false)
    }
  }

  // --- input ---
  const unsubscribeEvents = bridge.onEvenHubEvent((ev: EvenHubEvent) => {
    if (ev.audioEvent) {
      if (recording) {
        const pcm = new Uint8Array(ev.audioEvent.audioPcm)
        recBytes += pcm.length
        chunks.push(pcm)
        if (recBytes >= MAX_PCM_BYTES) void stopRecording()
      }
      return
    }

    // Long press can surface on any of the three event kinds depending on the focused container.
    const kinds = [ev.listEvent?.eventType, ev.textEvent?.eventType, ev.sysEvent?.eventType]
    if (kinds.includes(OsEventTypeList.LONG_PRESS_EVENT)) return void startRecording()
    if (kinds.includes(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)) return void stopRecording()

    if (ev.sysEvent) {
      const t = ev.sysEvent.eventType ?? 0
      switch (t) {
        case OsEventTypeList.DOUBLE_CLICK_EVENT:
          void bridge.shutDownPageContainer(1) // system exit dialog; cleanup happens on the exit events below
          return
        case OsEventTypeList.FOREGROUND_ENTER_EVENT:
          scheduleRender()
          return
        case OsEventTypeList.FOREGROUND_EXIT_EVENT:
          stopHardware()
          return
        case OsEventTypeList.ABNORMAL_EXIT_EVENT:
        case OsEventTypeList.SYSTEM_EXIT_EVENT:
          dispose()
          return
        case OsEventTypeList.CLICK_EVENT:
          if (state?.mode === 'saved') void undo()
          else if (state?.mode === 'limit') void cancelAll()
          return
        default:
          return
      }
    }

    if (ev.listEvent) {
      const t = ev.listEvent.eventType ?? 0
      if (t === OsEventTypeList.CLICK_EVENT && state?.mode === 'prompt') void choose(ev.listEvent.currentSelectItemIndex ?? 0)
      return
    }

    if (ev.textEvent) {
      const t = ev.textEvent.eventType ?? 0
      if ((t === OsEventTypeList.SCROLL_TOP_EVENT || t === OsEventTypeList.SCROLL_BOTTOM_EVENT) && state?.mode === 'limit') void dismissLimit()
    }
  })

  function dispose(): void {
    stopHardware()
    stopSub?.()
    stopSub = null
    unsubscribeEvents()
  }

  scheduleRender()
  connect()

  return {
    updateSettings(s) {
      api.update(s)
      state = null
      connect()
    },
    dispose,
  }
}
