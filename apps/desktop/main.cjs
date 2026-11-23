'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, shell, session, dialog, ipcMain } = require('electron');
const { isAllowedNavigation, isSafeExternalUrl, resolveAppUrl, isTrustedSender, folderFromDialog } = require('./config.cjs');

const OFFLINE_FILE = path.join(__dirname, 'offline.html');
const SMOKE = process.env.COMMAND_AI_SMOKE === '1';
const isDev = !app.isPackaged;

/** Configuração opcional do usuário: <userData>/config.json  ->  { "url": "https://..." } */
function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function readFileConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return typeof parsed.url === 'string' ? parsed.url : undefined;
  } catch {
    return undefined;
  }
}

let appUrl;
try {
  appUrl = resolveAppUrl({ env: process.env.COMMAND_AI_URL, file: readFileConfig() });
} catch (err) {
  console.error(`[command-ai] ${err.message}`);
  app.whenReady().then(() => {
    require('electron').dialog.showErrorBox('Command AI', `Configuração inválida do servidor.\n\n${err.message}`);
    app.exit(1);
  });
}

let win = null;

function loadApp() {
  if (!win) return;
  win.loadURL(appUrl).catch(() => {
    /* did-fail-load cuida da tela de erro */
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Command AI',
    backgroundColor: '#0d1117',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      // O app web é tratado como conteúdo não confiável para o sistema: sem Node, isolado e em sandbox.
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: isDev,
    },
  });

  win.once('ready-to-show', () => win && win.show());

  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ABORTED */) return;
    if (SMOKE) {
      console.log(JSON.stringify({ ok: false, error: `${code} ${desc}`, url }));
      return app.exit(2);
    }
    win.loadFile(OFFLINE_FILE, { query: { target: appUrl, reason: desc } }).catch(() => undefined);
  });

  win.on('closed', () => {
    win = null;
  });
  loadApp();
}

/* ---------------- segurança global ---------------- */
app.on('web-contents-created', (_event, contents) => {
  // Links que abrem janela nova vão para o navegador do sistema (só http/https). Nunca abrimos janelas internas.
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // A janela só navega dentro da origem do servidor.
  contents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url, appUrl, { offlineFile: OFFLINE_FILE })) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Command AI',
      submenu: [
        { label: 'Recarregar', accelerator: 'CmdOrCtrl+R', click: () => win && loadApp() },
        { label: 'Pasta de configuração', click: () => shell.showItemInFolder(configPath()) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: 'Sair' },
      ],
    },
    { label: 'Editar', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'Exibir',
      submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(isDev ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : [])],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (appUrl) {
  const gotLock = SMOKE ? true : app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.focus();
    });

    app.whenReady().then(() => {
      // Nenhuma permissão do navegador (câmera, microfone, localização…) é concedida.
      session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
      buildMenu();
      // Seletor de pasta para o cadastro de projetos: só atende a página do servidor configurado e devolve apenas o caminho.
      ipcMain.handle('command-ai:pick-folder', async (event) => {
        const sender = event.senderFrame ? event.senderFrame.url : '';
        if (!isTrustedSender(sender, appUrl)) return null;
        const result = await dialog.showOpenDialog(win, { title: 'Escolher a pasta do projeto', properties: ['openDirectory'] });
        return folderFromDialog(result);
      });
      createWindow();

      if (SMOKE) {
        win.webContents.once('did-finish-load', () => {
          setTimeout(async () => {
            try {
              const info = await win.webContents.executeJavaScript(
                `({ title: document.title, rootChildren: document.getElementById('root')?.children.length ?? 0, url: location.href, hasNode: typeof require !== 'undefined' || typeof process !== 'undefined', hasPicker: typeof window.commandAIDesktop?.pickFolder === 'function', bridgeKeys: Object.keys(window.commandAIDesktop || {}) })`,
              );
              const ok = info.title === 'Command AI' && info.rootChildren > 0 && !info.hasNode && info.hasPicker && info.bridgeKeys.length === 1;
              console.log(JSON.stringify({ ok, ...info }));
              app.exit(ok ? 0 : 1);
            } catch (err) {
              console.log(JSON.stringify({ ok: false, error: String(err) }));
              app.exit(1);
            }
          }, 2000);
        });
        setTimeout(() => {
          console.log(JSON.stringify({ ok: false, error: 'timeout' }));
          app.exit(3);
        }, 45_000);
      }

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    });

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit();
    });
  }
}
