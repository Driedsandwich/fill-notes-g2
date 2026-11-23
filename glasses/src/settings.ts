import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { Settings } from './api.ts'

const K_SERVER = 'fillnotes.server'
const K_PAIR = 'fillnotes.pair'

export const DEFAULT_SERVER = 'http://localhost:8787'

/** Settings live in the Even app's storage (browser localStorage is not reliable in that WebView). */
export async function loadSettings(bridge: EvenAppBridge): Promise<Settings> {
  const q = new URLSearchParams(location.search) // handy for the simulator: ?server=...&pair=...
  const server = q.get('server') || (await bridge.getLocalStorage(K_SERVER)) || DEFAULT_SERVER
  const pair = q.get('pair') || (await bridge.getLocalStorage(K_PAIR)) || ''
  return { server, pair }
}

export async function saveSettings(bridge: EvenAppBridge, s: Settings): Promise<void> {
  await bridge.setLocalStorage(K_SERVER, s.server)
  await bridge.setLocalStorage(K_PAIR, s.pair)
}

export interface SettingsUi {
  set(s: Settings): void
  status(text: string, kind?: 'ok' | 'err'): void
}

/** The phone-side screen: only the server address and the pairing code. Drawn before the bridge is ready. */
export function mountSettings(root: HTMLElement, initial: Settings, onSave: (s: Settings) => Promise<void>): SettingsUi {
  root.innerHTML = `
    <h1>Fill Notes <span class="badge">TESTNET</span></h1>
    <p class="dim">Notes for your paper-trading fills. No real money. Not trading advice.</p>
    <label for="server">Server address</label>
    <input id="server" inputmode="url" autocapitalize="off" autocomplete="off" placeholder="http://192.168.0.10:8787" />
    <label for="pair">Pair code (6 digits, shown when the server starts)</label>
    <input id="pair" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="123456" />
    <button id="save">Save</button>
    <div id="status"></div>`
  const server = root.querySelector<HTMLInputElement>('#server')!
  const pair = root.querySelector<HTMLInputElement>('#pair')!
  const status = root.querySelector<HTMLElement>('#status')!
  server.value = initial.server
  pair.value = initial.pair
  const ui: SettingsUi = {
    set(s) {
      server.value = s.server
      pair.value = s.pair
    },
    status(text, kind) {
      status.textContent = text
      status.className = kind ?? ''
    },
  }
  root.querySelector<HTMLButtonElement>('#save')!.addEventListener('click', () => {
    const s = { server: server.value.trim(), pair: pair.value.trim() }
    if (!/^https?:\/\//.test(s.server)) return ui.status('Server address must start with http:// or https://', 'err')
    if (!/^\d{6}$/.test(s.pair)) return ui.status('Pair code is 6 digits', 'err')
    ui.status('Saving...')
    onSave(s).then(
      () => ui.status('Saved. Connecting...'),
      (e: Error) => ui.status(`Could not save: ${e.message}`, 'err'),
    )
  })
  return ui
}
