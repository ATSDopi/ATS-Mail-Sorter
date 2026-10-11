import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type {
  Settings, GmailTokens, EmailSummary, CategorizationResult, GmailLabel,
  AiProvider, ProviderTestResult,
} from './types';

type ProgressCallback = (data: unknown) => void;

function on(channel: string) {
  return (cb: ProgressCallback): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

const api = {
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    save: (settings: Settings): Promise<Settings> => ipcRenderer.invoke('settings:save', settings),
    discover: (): Promise<Settings> => ipcRenderer.invoke('settings:discover'),
  },
  gmail: {
    connect: (): Promise<GmailTokens> => ipcRenderer.invoke('gmail:connect'),
    disconnect: (): Promise<boolean> => ipcRenderer.invoke('gmail:disconnect'),
    listEmails: (max?: number): Promise<EmailSummary[]> => ipcRenderer.invoke('gmail:listEmails', max),
    getBody: (id: string): Promise<string> => ipcRenderer.invoke('gmail:getBody', id),
    listLabels: (): Promise<GmailLabel[]> => ipcRenderer.invoke('gmail:listLabels'),
    openMessage: (id: string): Promise<boolean> => ipcRenderer.invoke('gmail:openMessage', id),
  },
  ai: {
    categorizeOne: (id: string): Promise<CategorizationResult> => ipcRenderer.invoke('ai:categorizeOne', id),
    categorizeBatch: (max?: number, dryRun?: boolean): Promise<CategorizationResult[]> => ipcRenderer.invoke('ai:categorizeBatch', max, dryRun),
    categorizeAll: (dryRun?: boolean): Promise<CategorizationResult[]> => ipcRenderer.invoke('ai:categorizeAll', dryRun),
    cancelSort: (): Promise<boolean> => ipcRenderer.invoke('ai:cancelSort'),
    onSortProgress: on('sort:progress'),
    onSortResult: on('sort:result'),
    onSortStart: on('sort:start'),
    onSortDone: on('sort:done'),
    onSortCancelled: on('sort:cancelled'),
    onSortProvider: on('sort:provider'),
    onSortError: on('sort:error'),
    onSortRetry: on('sort:retry'),
  },
  providers: {
    test: (provider: AiProvider): Promise<ProviderTestResult> => ipcRenderer.invoke('providers:test', provider),
  },
  debug: {
    getLogs: (): Promise<string> => ipcRenderer.invoke('debug:getLogs'),
    getProviderStats: (): Promise<string> => ipcRenderer.invoke('debug:getProviderStats'),
    testProviders: (): Promise<string> => ipcRenderer.invoke('debug:testProviders'),
  },
};

contextBridge.exposeInMainWorld('mailSorter', api);

export type MailSorterApi = typeof api;
