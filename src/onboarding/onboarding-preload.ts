import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  requestAccessibility: () => ipcRenderer.invoke('request-accessibility'),
  speak:               (text: string) => ipcRenderer.invoke('onboarding-speak', text),
  completeOnboarding:  () => ipcRenderer.invoke('complete-onboarding'),
  onWakeWordDetected:  (callback: () => void) => {
    ipcRenderer.once('wake-word-detected', () => callback());
  },
});
