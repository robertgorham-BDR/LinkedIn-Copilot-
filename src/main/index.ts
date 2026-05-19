import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import log from 'electron-log';
import { ensureDefaultUser, getDb, initSchema } from './db/client';
import { seedAll } from './db/seed';
import { registerIpc } from './ipc/handlers';
import { closeContext } from './browser/session';
import { startBackgroundSync, stopBackgroundSync } from './agent/sync';
import { startSendQueueWorker, stopSendQueueWorker } from './agent/sendQueue';
import { startAutoBackup, stopAutoBackup } from './db/backup';

log.transports.file.level = 'info';
log.info('app starting');

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const iconPath = process.platform === 'darwin'
    ? join(__dirname, '../../build/icon.icns')
    : process.platform === 'win32'
    ? join(__dirname, '../../build/icon.ico')
    : join(__dirname, '../../build/icon.png');
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    title: 'LinkedIn Copilot',
    icon: iconPath,
    backgroundColor: '#0e1116',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// Single-instance lock — prevent two app processes from racing on the SQLite
// file (WAL mode is concurrent-safe but seeders / migrations are not).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log.warn('another instance is already running — quitting this one');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    if (process.platform === 'darwin' && app.dock) {
      try {
        app.dock.setIcon(join(__dirname, '../../build/icon.png'));
      } catch (err) {
        log.warn('dock.setIcon failed', err);
      }
    }
    initSchema();
    const user = ensureDefaultUser();
    log.info('default user', user);
    seedAll(user.id);
    registerIpc(() => mainWindow);
    createWindow();
    startBackgroundSync(user.id, 15);
    startSendQueueWorker(1);
    startAutoBackup(24);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', async () => {
  stopBackgroundSync();
  stopSendQueueWorker();
  stopAutoBackup();
  await closeContext();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  stopBackgroundSync();
  stopSendQueueWorker();
  stopAutoBackup();
  await closeContext();
});

// Surface uncaught errors to the log; they'd otherwise vanish silently.
process.on('uncaughtException', (err) => log.error('uncaughtException', err));
process.on('unhandledRejection', (err) => log.error('unhandledRejection', err));

// Suppress unused-import warnings for ipcMain/getDb when typecheck-only builds run.
void ipcMain;
void getDb;
