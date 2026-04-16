import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('onboarding', {
  getScreenPermission:        () => ipcRenderer.invoke('permissions:screen'),
  getAccessibilityPermission: () => ipcRenderer.invoke('permissions:accessibility'),
  requestAccessibility:       () => ipcRenderer.invoke('permissions:requestAccessibility'),
  speak:        (text: string)  => ipcRenderer.invoke('onboarding:speak', text),
  listen:       (secs: number)  => ipcRenderer.invoke('onboarding:listen', secs),
  saveAnswers:  (qa: unknown)   => ipcRenderer.invoke('onboarding:saveAnswers', qa),
  complete:     ()              => ipcRenderer.invoke('onboarding:complete'),
});
