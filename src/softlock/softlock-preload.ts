import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('softlock', {
  onState:    (cb: (state: unknown) => void) => ipcRenderer.on('softlock:state', (_e, s) => cb(s)),
  going:      ()               => ipcRenderer.invoke('softlock:going'),
  override:   ()               => ipcRenderer.invoke('softlock:override'),
});
