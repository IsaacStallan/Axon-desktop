import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('axon', {
  onStateChange: (cb: (state: string) => void) =>
    ipcRenderer.on('orb:state', (_e, state) => cb(state)),
  onMessage: (cb: (msg: string) => void) =>
    ipcRenderer.on('orb:message', (_e, msg) => cb(msg)),
  tapOrb: () => ipcRenderer.send('orb:tap'),
  ready: () => ipcRenderer.send('orb:ready'),
});
