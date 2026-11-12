import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

type Listener = (payload: unknown) => void;

function subscribe(channel: string, fn: Listener): () => void {
  const handler = (_e: IpcRendererEvent, payload: unknown): void => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

// The page talks to swarmupd only through the main process, which holds the API token.
contextBridge.exposeInMainWorld('swarmup', {
  info: () => ipcRenderer.invoke('swarmup:info'),
  setupStatus: () => ipcRenderer.invoke('swarmup:setup-status'),
  setup: (me: string, roots: string[]) => ipcRenderer.invoke('swarmup:setup', me, roots),
  restart: () => ipcRenderer.invoke('swarmup:restart'),
  runtime: (name: string, input: unknown) => ipcRenderer.invoke('swarmup:runtime', name, input),
  service: (action: string) => ipcRenderer.invoke('swarmup:service', action),
  desktop: () => ipcRenderer.invoke('swarmup:desktop'),
  update: (action?: 'check' | 'install') => ipcRenderer.invoke('swarmup:update', action),
  onUpdate: (fn: Listener) => subscribe('swarmup:update', fn),
  desktopSet: (patch: unknown) => ipcRenderer.invoke('swarmup:desktop-set', patch),
  voice: () => ipcRenderer.invoke('swarmup:voice'),
  voiceSet: (patch: unknown) => ipcRenderer.invoke('swarmup:voice-set', patch),
  voiceBrowse: (kind: 'program' | 'model') => ipcRenderer.invoke('swarmup:voice-browse', kind),
  transcribe: (wav: Uint8Array) => ipcRenderer.invoke('swarmup:transcribe', wav),
  saveImages: (files: Array<{ name: string; data: Uint8Array }>) =>
    ipcRenderer.invoke('swarmup:save-images', files),
  videoFolder: () => ipcRenderer.invoke('swarmup:video-folder'),
  saveVideo: (name: string, data: Uint8Array) =>
    ipcRenderer.invoke('swarmup:save-video', name, data),
  projectPick: () => ipcRenderer.invoke('swarmup:project-pick'),
  projectPlan: (name: string) => ipcRenderer.invoke('swarmup:project-plan', name),
  projectStore: () => ipcRenderer.invoke('swarmup:project-store'),
  projectCreate: (input: unknown) => ipcRenderer.invoke('swarmup:project-create', input),
  call: (method: 'GET' | 'POST', path: string, body?: unknown) =>
    ipcRenderer.invoke('swarmup:call', method, path, body),
  onEvent: (fn: Listener) => subscribe('swarmup:event', fn),
  onStatus: (fn: Listener) => subscribe('swarmup:status', fn),
  onNavigate: (fn: Listener) => subscribe('swarmup:navigate', fn),
  onService: (fn: Listener) => subscribe('swarmup:service', fn),
});
