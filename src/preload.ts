import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('axon', {
  onStateChange: (cb: (state: string) => void) =>
    ipcRenderer.on('orb:state', (_e, state) => cb(state)),
  onMessage: (cb: (msg: string) => void) =>
    ipcRenderer.on('orb:message', (_e, msg) => cb(msg)),
  onStatsUpdate: (cb: (stats: unknown) => void) =>
    ipcRenderer.on('axon:stats', (_e, stats) => cb(stats)),
  tapOrb: () => ipcRenderer.send('orb:tap'),
  ready: () => ipcRenderer.send('orb:ready'),
  minimiseWindow: () => ipcRenderer.send('orb:minimise'),
  toPill: () => ipcRenderer.send('orb:to-pill'),
  fromPill: () => ipcRenderer.send('orb:from-pill'),
  onMicStart: (cb: () => void) =>
    ipcRenderer.on('mic:start', () => cb()),
  onMicStop: (cb: () => void) =>
    ipcRenderer.on('mic:stop', () => cb()),
  sendMicChunk: (chunk: Uint8Array) =>
    ipcRenderer.send('mic:chunk', chunk),
  sendMicError: (msg: string) =>
    ipcRenderer.send('mic:error', msg),
  sendMicReady: () =>
    ipcRenderer.send('mic:ready'),
});
