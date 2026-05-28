import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('axon', {
  onStateChange: (cb: (state: string) => void) =>
    ipcRenderer.on('orb:state', (_e, state) => cb(state)),
  onMessage: (cb: (msg: string) => void) =>
    ipcRenderer.on('orb:message', (_e, msg) => cb(msg)),
  onStatsUpdate: (cb: (stats: unknown) => void) =>
    ipcRenderer.on('axon:stats', (_e, stats) => cb(stats)),
  onStats: (cb: (data: unknown) => void) =>
    ipcRenderer.on('axon:stats', (_e, data) => cb(data)),
  onLog: (cb: (data: unknown) => void) =>
    ipcRenderer.on('axon:log', (_e, data) => cb(data)),
  tapOrb:        () => ipcRenderer.send('orb:tap'),
  ready:         () => ipcRenderer.send('orb:ready'),
  interruptAxon: () => ipcRenderer.send('axon:interrupt'),
  minimiseWindow: () => ipcRenderer.send('orb:minimise'),
  toPill: () => ipcRenderer.send('orb:to-pill'),
  fromPill: () => ipcRenderer.send('orb:from-pill'),
  onActivityUpdate: (cb: (activity: string) => void) =>
    ipcRenderer.on('axon:activity', (_e, activity) => cb(activity)),
  onAgentsUpdate: (cb: (agents: unknown[]) => void) =>
    ipcRenderer.on('axon:agents', (_e, agents) => cb(agents)),
  onMicStart: (cb: () => void) =>
    ipcRenderer.on('mic:start', () => cb()),
  onMicStop: (cb: () => void) =>
    ipcRenderer.on('mic:stop', () => cb()),
  onMicRestart: (cb: () => void) =>
    ipcRenderer.on('mic:restart', () => cb()),
  sendMicChunk: (chunk: Uint8Array) =>
    ipcRenderer.send('mic:chunk', chunk),
  sendMicError: (msg: string) =>
    ipcRenderer.send('mic:error', msg),
  sendMicReady: () =>
    ipcRenderer.send('mic:ready'),
  sendMicDied: () =>
    ipcRenderer.send('mic:died'),
});
