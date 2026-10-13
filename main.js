'use strict';
// Processo principal: janela, protocolo app://, diálogos de abrir/salvar e fontes do Windows.

const { app, BrowserWindow, ipcMain, dialog, protocol, net, Menu, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

const ROOT = __dirname;
// Só estas pastas podem ser servidas pelo app://local/
const SERVED_DIRS = [
  'app',
  'node_modules/pdfjs-dist/build',
  'node_modules/pdfjs-dist/cmaps',
  'node_modules/pdfjs-dist/standard_fonts',
  'node_modules/pdfjs-dist/wasm',
  'node_modules/pdfjs-dist/iccs',
  'node_modules/fabric/dist',
  'node_modules/pdf-lib/dist',
  'node_modules/@pdf-lib/fontkit/dist',
].map((d) => path.join(ROOT, d) + path.sep);

// Fontes do Windows usadas para gravar o texto no PDF (regular, negrito, itálico, negrito+itálico)
const FONT_FILES = {
  'Arial': ['arial.ttf', 'arialbd.ttf', 'ariali.ttf', 'arialbi.ttf'],
  'Times New Roman': ['times.ttf', 'timesbd.ttf', 'timesi.ttf', 'timesbi.ttf'],
  'Courier New': ['cour.ttf', 'courbd.ttf', 'couri.ttf', 'courbi.ttf'],
  'Calibri': ['calibri.ttf', 'calibrib.ttf', 'calibrii.ttf', 'calibriz.ttf'],
  'Verdana': ['verdana.ttf', 'verdanab.ttf', 'verdanai.ttf', 'verdanaz.ttf'],
  'Georgia': ['georgia.ttf', 'georgiab.ttf', 'georgiai.ttf', 'georgiaz.ttf'],
};

const selftestArg = process.argv.find((a) => a.startsWith('--selftest='));
const selftestDir = selftestArg ? path.resolve(selftestArg.slice('--selftest='.length)) : null;

let win = null;
let pendingFile = null; // arquivo recebido pela linha de comando ("Abrir com")
let dirty = false;
const writablePaths = new Set(); // caminhos que o usuário escolheu num diálogo de salvar

function pdfArgFrom(argv) {
  return argv.slice(1).find((a) => !a.startsWith('-') && a.toLowerCase().endsWith('.pdf')) || null;
}

async function readPdf(filePath) {
  const data = await fs.readFile(filePath);
  return { path: filePath, name: path.basename(filePath), data: new Uint8Array(data) };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Editor PDF',
    backgroundColor: '#eef0f3',
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (selftestDir) {
    win.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message}`));
    win.webContents.on('render-process-gone', (_e, d) => { console.error('renderer caiu', d); app.exit(2); });
    setTimeout(() => { console.error('autoteste passou do tempo'); app.exit(3); }, 90000);
  }
  win.loadURL('app://local/app/index.html');
  win.once('ready-to-show', () => { if (!selftestDir) win.maximize(); win.show(); });

  // Nada de navegação ou janelas novas dentro do app; links externos vão para o navegador
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', (e) => {
    if (!dirty || selftestDir) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Sair sem salvar', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      title: 'Alterações não salvas',
      message: 'Há alterações que ainda não foram salvas.',
      detail: 'Se sair agora, elas serão perdidas.',
    });
    if (choice === 1) e.preventDefault();
  });
}

if (!selftestDir && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', async (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const file = pdfArgFrom(argv);
    if (file) {
      try { win.webContents.send('file:opened', await readPdf(file)); } catch { /* arquivo sumiu */ }
    }
  });

  app.whenReady().then(async () => {
    protocol.handle('app', (request) => {
      const url = new URL(request.url);
      const target = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
      if (url.host !== 'local' || !SERVED_DIRS.some((d) => target.startsWith(d))) {
        return new Response('Não encontrado', { status: 404 });
      }
      return net.fetch(pathToFileURL(target).toString());
    });

    Menu.setApplicationMenu(null);
    const file = pdfArgFrom(process.argv);
    if (file) {
      try { pendingFile = await readPdf(file); } catch { pendingFile = null; }
    }
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}

// ---------- IPC ----------

ipcMain.handle('app:initialFile', () => {
  const f = pendingFile;
  pendingFile = null;
  return f;
});

ipcMain.on('app:dirty', (_e, value) => { dirty = !!value; });

ipcMain.handle('pdf:open', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Abrir PDF',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return readPdf(r.filePaths[0]);
});

ipcMain.handle('pdf:pickMany', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Inserir páginas de outro PDF',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map(readPdf));
});

ipcMain.handle('img:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Escolher imagem',
    filters: [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  const data = await fs.readFile(p);
  const mime = /\.png$/i.test(p) ? 'image/png' : 'image/jpeg';
  return { name: path.basename(p), mime, data: new Uint8Array(data) };
});

ipcMain.handle('pdf:save', async (_e, data, opts = {}) => {
  let target = opts.path && writablePaths.has(opts.path) && !opts.saveAs ? opts.path : null;
  if (selftestDir && opts.selftestName) target = path.join(selftestDir, path.basename(opts.selftestName));
  if (!target) {
    const r = await dialog.showSaveDialog(win, {
      title: 'Salvar PDF',
      defaultPath: opts.suggestedPath || 'documento.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath.toLowerCase().endsWith('.pdf') ? r.filePath : r.filePath + '.pdf';
    writablePaths.add(target);
  }
  // Grava num temporário e troca, para não corromper o arquivo se algo falhar no meio
  const tmp = target + '.tmp-' + process.pid;
  await fs.writeFile(tmp, Buffer.from(data));
  await fs.rename(tmp, target);
  return { path: target, name: path.basename(target) };
});

ipcMain.handle('font:get', async (_e, family, variant) => {
  const files = FONT_FILES[family];
  if (!files) return null;
  const file = files[Math.max(0, Math.min(3, variant | 0))];
  const fontsDir = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
  for (const name of [file, files[0]]) {
    try { return new Uint8Array(await fs.readFile(path.join(fontsDir, name))); } catch { /* tenta a regular */ }
  }
  return null;
});

ipcMain.handle('font:families', () => Object.keys(FONT_FILES));

// ---------- autoteste (npm run selftest) ----------

ipcMain.handle('test:config', async () => {
  if (!selftestDir) return null;
  const fixtures = path.resolve('test-fixtures');
  return {
    main: await readPdf(path.join(fixtures, 'contrato.pdf')),
    extra: await readPdf(path.join(fixtures, 'anexo.pdf')),
  };
});

ipcMain.handle('test:screenshot', async (_e, name) => {
  if (!selftestDir) return null;
  const img = await win.webContents.capturePage();
  await fs.mkdir(selftestDir, { recursive: true });
  await fs.writeFile(path.join(selftestDir, path.basename(name)), img.toPNG());
  return true;
});

ipcMain.handle('test:report', async (_e, report) => {
  if (!selftestDir) return null;
  await fs.mkdir(selftestDir, { recursive: true });
  await fs.writeFile(path.join(selftestDir, 'report.json'), JSON.stringify(report, null, 2));
  setTimeout(() => app.exit(report && report.ok ? 0 : 1), 200);
  return true;
});
