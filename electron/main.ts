import { app, BrowserWindow, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { registerIpc } from './ipc';

// Protection : si ELECTRON_RUN_AS_NODE est défini, les APIs Electron
// (app, BrowserWindow, etc.) sont undefined. On supprime cette variable
// au cas où elle aurait été héritée de l'environnement.
delete process.env.ELECTRON_RUN_AS_NODE;

// Force le nom de l'app pour que userData pointe vers le bon dossier
// (sinon en dev Electron utilise "Electron" comme nom par défaut).
app.setName('ats-mail-sorter');

// Une seule instance : si l'utilisateur relance l'app, on focus la fenêtre
// existante au lieu d'ouvrir un deuxième process (conflit OAuth/lock).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// --- Système de log persistant ---
// Initialisé après app.whenReady() car app.getPath() nécessite l'app prête.
let logFile: string | null = null;
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB max, rotation au-delà.

function rotateLogIfNeeded(): void {
  if (!logFile) return;
  try {
    const stats = fs.statSync(logFile);
    if (stats.size > MAX_LOG_SIZE) {
      fs.renameSync(logFile, logFile + '.old');
    }
  } catch { /* fichier n'existe pas encore */ }
}

function logToFile(level: string, msg: string): void {
  if (!logFile) return;
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${level} ${msg}\n`;
  try {
    rotateLogIfNeeded();
    fs.appendFileSync(logFile, line, 'utf8');
  } catch { /* disque plein ou autre — ignore */ }
}

// Intercepte console.log/warn/error pour écrire dans le fichier aussi.
// Un stdout fermé (app GUI sans console, pipe parent mort) ne doit
// JAMAIS planter le process : EPIPE/EBADF sont avalés.
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
function safeWrite(fn: (...a: unknown[]) => void, args: unknown[]): void {
  try {
    fn(...args);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'EPIPE' && (e as NodeJS.ErrnoException)?.code !== 'EBADF') throw e;
  }
}
console.log = (...args: unknown[]) => { safeWrite(origLog, args); logToFile('LOG', args.map(String).join(' ')); };
console.warn = (...args: unknown[]) => { safeWrite(origWarn, args); logToFile('WARN', args.map(String).join(' ')); };
console.error = (...args: unknown[]) => { safeWrite(origError, args); logToFile('ERROR', args.map(String).join(' ')); };

// Log les exceptions non gérées.
process.on('uncaughtException', (err) => {
  safeWrite(origError, ['[FATAL] Exception non gérée:', err]);
  logToFile('FATAL', String(err instanceof Error ? err.stack ?? err.message : err));
});

// Vite dev server en mode dev, fichier buildé en mode prod.
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = !!VITE_DEV_SERVER_URL;

let mainWindow: BrowserWindow | null = null;

/** Protège la fenêtre : liens externes dans le navigateur, navigation bloquée. */
function hardenWindow(win: BrowserWindow): void {
  // target="_blank" et window.open → navigateur système pour http(s).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Interdit toute navigation de la fenêtre vers une autre origine
  // (l'app ne doit afficher que son propre UI, jamais du web arbitraire).
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev ? url.startsWith(VITE_DEV_SERVER_URL!) : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      if (url.startsWith('https://')) shell.openExternal(url);
    }
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 600,
    title: 'Mail Sorter AI',
    icon: path.join(__dirname, '../build/icon.png'),
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  hardenWindow(mainWindow);

  if (isDev) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL!);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Initialise le fichier de log (app.getPath nécessite app prête).
  logFile = path.join(app.getPath('userData'), 'mail-sorter.log');
  console.log('[app] démarrage — logs dans', logFile);

  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
