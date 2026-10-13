'use strict';
// Processo principal: janela, protocolo app://, diálogos, motor MuPDF (thread), fontes,
// arquivos recentes e impressão.

const { app, BrowserWindow, ipcMain, dialog, protocol, net, Menu, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { Worker } = require('node:worker_threads');
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
  'node_modules/docx/dist',
].map((d) => path.join(ROOT, d) + path.sep);

const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

// Fontes do sistema usadas para gravar o texto no PDF (regular, negrito, itálico, negrito+itálico)
const LINUX_FONTS = {
  'Arial': ['LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf', 'LiberationSans-Italic.ttf', 'LiberationSans-BoldItalic.ttf'],
  'Times New Roman': ['LiberationSerif-Regular.ttf', 'LiberationSerif-Bold.ttf', 'LiberationSerif-Italic.ttf', 'LiberationSerif-BoldItalic.ttf'],
  'Courier New': ['LiberationMono-Regular.ttf', 'LiberationMono-Bold.ttf', 'LiberationMono-Italic.ttf', 'LiberationMono-BoldItalic.ttf'],
  'DejaVu Sans': ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf', 'DejaVuSans-Oblique.ttf', 'DejaVuSans-BoldOblique.ttf'],
  'DejaVu Serif': ['DejaVuSerif.ttf', 'DejaVuSerif-Bold.ttf', 'DejaVuSerif-Italic.ttf', 'DejaVuSerif-BoldItalic.ttf'],
};
const FONT_FILES = IS_LINUX ? LINUX_FONTS : IS_MAC ? {
  'Arial': ['Arial.ttf', 'Arial Bold.ttf', 'Arial Italic.ttf', 'Arial Bold Italic.ttf'],
  'Times New Roman': ['Times New Roman.ttf', 'Times New Roman Bold.ttf', 'Times New Roman Italic.ttf', 'Times New Roman Bold Italic.ttf'],
  'Courier New': ['Courier New.ttf', 'Courier New Bold.ttf', 'Courier New Italic.ttf', 'Courier New Bold Italic.ttf'],
  'Verdana': ['Verdana.ttf', 'Verdana Bold.ttf', 'Verdana Italic.ttf', 'Verdana Bold Italic.ttf'],
  'Georgia': ['Georgia.ttf', 'Georgia Bold.ttf', 'Georgia Italic.ttf', 'Georgia Bold Italic.ttf'],
  'Tahoma': ['Tahoma.ttf', 'Tahoma Bold.ttf', 'Tahoma.ttf', 'Tahoma Bold.ttf'],
  'Trebuchet MS': ['Trebuchet MS.ttf', 'Trebuchet MS Bold.ttf', 'Trebuchet MS Italic.ttf', 'Trebuchet MS Bold Italic.ttf'],
  // Fontes manuscritas (assinatura digitada)
  'Brush Script MT': ['Brush Script.ttf', 'Brush Script.ttf', 'Brush Script.ttf', 'Brush Script.ttf'],
  'Apple Chancery': ['Apple Chancery.ttf', 'Apple Chancery.ttf', 'Apple Chancery.ttf', 'Apple Chancery.ttf'],
} : {
  'Arial': ['arial.ttf', 'arialbd.ttf', 'ariali.ttf', 'arialbi.ttf'],
  'Times New Roman': ['times.ttf', 'timesbd.ttf', 'timesi.ttf', 'timesbi.ttf'],
  'Courier New': ['cour.ttf', 'courbd.ttf', 'couri.ttf', 'courbi.ttf'],
  'Calibri': ['calibri.ttf', 'calibrib.ttf', 'calibrii.ttf', 'calibriz.ttf'],
  'Verdana': ['verdana.ttf', 'verdanab.ttf', 'verdanai.ttf', 'verdanaz.ttf'],
  'Georgia': ['georgia.ttf', 'georgiab.ttf', 'georgiai.ttf', 'georgiaz.ttf'],
  'Tahoma': ['tahoma.ttf', 'tahomabd.ttf', 'tahoma.ttf', 'tahomabd.ttf'],
  'Trebuchet MS': ['trebuc.ttf', 'trebucbd.ttf', 'trebucit.ttf', 'trebucbi.ttf'],
  'Segoe UI': ['segoeui.ttf', 'segoeuib.ttf', 'segoeuii.ttf', 'segoeuiz.ttf'],
  // Fontes manuscritas (assinatura digitada)
  'Segoe Script': ['segoesc.ttf', 'segoescb.ttf', 'segoesc.ttf', 'segoescb.ttf'],
  'Ink Free': ['Inkfree.ttf', 'Inkfree.ttf', 'Inkfree.ttf', 'Inkfree.ttf'],
  'Lucida Handwriting': ['LHANDW.TTF', 'LHANDW.TTF', 'LHANDW.TTF', 'LHANDW.TTF'],
};
const SCRIPT_FONTS = ['Segoe Script', 'Ink Free', 'Lucida Handwriting', 'Brush Script MT', 'Apple Chancery'];
const FONT_DIRS = IS_LINUX
  ? ['/usr/share/fonts/truetype/liberation', '/usr/share/fonts/truetype/liberation2', '/usr/share/fonts/liberation-sans', '/usr/share/fonts/liberation-serif', '/usr/share/fonts/liberation-mono', '/usr/share/fonts/truetype/dejavu', '/usr/share/fonts/dejavu', '/usr/share/fonts/TTF', path.join(process.env.HOME || '', '.local', 'share', 'fonts')]
  : IS_MAC
  ? ['/System/Library/Fonts/Supplemental', '/Library/Fonts', '/System/Library/Fonts', path.join(process.env.HOME || '', 'Library', 'Fonts')]
  : [path.join(process.env.WINDIR || 'C:\Windows', 'Fonts'), path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts')];

let linuxFontIndex = null;
async function linuxFonts() {
  if (linuxFontIndex) return linuxFontIndex;
  linuxFontIndex = new Map();
  for (const root of ['/usr/share/fonts', '/usr/local/share/fonts', path.join(process.env.HOME || '', '.local', 'share', 'fonts'), path.join(process.env.HOME || '', '.fonts')]) {
    let list = [];
    try { list = await fs.readdir(root, { recursive: true }); } catch { continue; }
    for (const rel of list) {
      const base = path.basename(rel);
      if (/\.(ttf|otf)$/i.test(base) && !linuxFontIndex.has(base)) linuxFontIndex.set(base, path.join(root, rel));
    }
  }
  return linuxFontIndex;
}

async function findFontFile(name) {
  if (IS_LINUX) return (await linuxFonts()).get(name) || null;
  for (const dir of FONT_DIRS) {
    const p = path.join(dir, name);
    try { await fs.access(p); return p; } catch { /* próxima pasta */ }
  }
  return null;
}

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'];
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', pdf: 'application/pdf' };

const selftestArg = process.argv.find((a) => a.startsWith('--selftest='));
const selftestDir = selftestArg ? path.resolve(selftestArg.slice('--selftest='.length)) : null;
const selftestLang = (process.argv.find((a) => a.startsWith('--lang=')) || '--lang=pt').slice(7);

let win = null;
let pendingFile = null; // arquivo recebido pela linha de comando ("Abrir com")
let dirty = false;
let lang = /^pt/i.test(app.getLocale?.() || '') ? 'pt' : 'en';

// Textos das janelas nativas (o resto da interface é traduzido no app/js/i18n.js)
const MAIN_EN = {
  'Sair sem salvar': 'Quit without saving', 'Cancelar': 'Cancel', 'Alterações não salvas': 'Unsaved changes',
  'Há alterações que ainda não foram salvas.': 'There are changes that have not been saved.',
  'Se sair agora, elas serão perdidas.': 'If you quit now, they will be lost.',
  'Abrir': 'Open', 'PDF e imagens': 'PDF and images', 'Imagens': 'Images', 'Escolher imagem': 'Choose image',
  'Inserir páginas': 'Insert pages', 'Salvar PDF': 'Save PDF', 'Exportar': 'Export', 'Escolher pasta': 'Choose folder',
  'O PDF demorou demais para processar e a operação foi cancelada.': 'The PDF took too long to process and the operation was cancelled.',
  'Operação cancelada.': 'Operation cancelled.',
};
const tr = (s) => (lang === 'en' && MAIN_EN[s]) || s;
const writablePaths = new Set(); // arquivos que o usuário escolheu num diálogo de salvar
const writableDirs = new Set();  // pastas escolhidas para exportar

const extOf = (p) => path.extname(p).slice(1).toLowerCase();

function fileArgFrom(argv) {
  return argv.slice(1).find((a) => !a.startsWith('-') && (extOf(a) === 'pdf' || IMAGE_EXT.includes(extOf(a)))) || null;
}

const deliveredPaths = new Set(); // arquivos abertos por diálogo, linha de comando ou Finder

async function readUserFile(filePath) {
  const data = await fs.readFile(filePath);
  deliveredPaths.add(filePath);
  return { path: filePath, name: path.basename(filePath), mime: MIME[extOf(filePath)] || 'application/octet-stream', data: new Uint8Array(data) };
}

// ---------- arquivos recentes ----------

const recentFile = () => path.join(app.getPath('userData'), 'recentes.json');
async function readRecent() {
  try { return JSON.parse(await fs.readFile(recentFile(), 'utf8')).filter((r) => r && typeof r.path === 'string'); } catch { return []; }
}
async function addRecent(filePath) {
  if (!filePath || selftestDir || extOf(filePath) !== 'pdf') return;
  const list = (await readRecent()).filter((r) => r.path.toLowerCase() !== filePath.toLowerCase());
  list.unshift({ path: filePath, name: path.basename(filePath), at: Date.now() });
  await fs.mkdir(path.dirname(recentFile()), { recursive: true });
  await fs.writeFile(recentFile(), JSON.stringify(list.slice(0, 12), null, 1));
  app.addRecentDocument(filePath);
}

// ---------- motor MuPDF numa thread ----------

let engine = null;
let ocrFontPath = null; // fonte usada na camada de texto do OCR (definida ao iniciar)
let srgbPath = null; // perfil de cor sRGB do sistema (exigido pelo PDF/A)
const SRGB_CANDIDATES = [
  path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'spool', 'drivers', 'color', 'sRGB Color Space Profile.icm'),
  '/System/Library/ColorSync/Profiles/sRGB Profile.icc',
  '/usr/share/color/icc/colord/sRGB.icc',
  '/usr/share/color/icc/sRGB.icc',
  '/usr/share/color/icc/ghostscript/srgb.icc',
];
let engineSeq = 0;
const enginePending = new Map();

// Dentro do instalador o motor, o MuPDF e o OCR ficam fora do .asar (app.asar.unpacked)
const unpacked = (p) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

function getEngine() {
  if (engine) return engine;
  engine = new Worker(unpacked(path.join(ROOT, 'engine', 'worker.mjs')), {
    workerData: {
      tessdata: unpacked(path.join(ROOT, 'vendor', 'tessdata')),
      tessCache: path.join(app.getPath('userData'), 'ocr-cache'),
      ocrFont: ocrFontPath,
      srgb: srgbPath,
    },
  });
  const self = engine;
  engine.on('message', ({ id, result, error, progress }) => {
    const p = enginePending.get(id);
    if (!p) return;
    if (progress) { win?.webContents.send('engine:progress', progress); return; }
    enginePending.delete(id);
    error ? p.reject(new Error(error)) : p.resolve(result);
  });
  const fail = (err) => {
    if (engine !== self) return; // erro de um motor antigo, já substituído
    for (const p of enginePending.values()) p.reject(err);
    enginePending.clear();
    engine = null;
  };
  engine.on('error', fail);
  engine.on('exit', (code) => { if (engine !== self) return; if (code !== 0) fail(new Error(`motor PDF parou (${code})`)); else engine = null; });
  return engine;
}

// Cada operação tem prazo; se um PDF travar o motor, ele é reiniciado e a operação falha com aviso
const ENGINE_TIMEOUT = { pdfa: 30 * 60e3, ocr: 20 * 60e3, toDocx: 10 * 60e3, compress: 10 * 60e3, renderPages: 10 * 60e3 };
function engineCall(op, args) {
  return new Promise((resolve, reject) => {
    const id = ++engineSeq;
    const timer = setTimeout(() => {
      if (!enginePending.has(id)) return;
      enginePending.delete(id);
      reject(new Error(tr('O PDF demorou demais para processar e a operação foi cancelada.')));
      const stuck = engine;
      engine = null;
      for (const p of enginePending.values()) p.reject(new Error(tr('Operação cancelada.')));
      enginePending.clear();
      stuck?.terminate();
    }, ENGINE_TIMEOUT[op] || 3 * 60e3);
    enginePending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    getEngine().postMessage({ id, op, args });
  });
}

const ENGINE_OPS = new Set(['inspect', 'unlock', 'redact', 'finalize', 'compress', 'renderPages', 'structuredText', 'toDocx', 'ocr', 'fontReport', 'pdfa']);

// ---------- janela ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 620,
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
    setTimeout(() => { console.error('autoteste passou do tempo'); app.exit(3); }, 240000);
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
      buttons: [tr('Sair sem salvar'), tr('Cancelar')],
      defaultId: 1,
      cancelId: 1,
      title: tr('Alterações não salvas'),
      message: tr('Há alterações que ainda não foram salvas.'),
      detail: tr('Se sair agora, elas serão perdidas.'),
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
    const file = fileArgFrom(argv);
    if (file) {
      try { win.webContents.send('file:opened', await readUserFile(file)); } catch { /* arquivo sumiu */ }
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

    // No Mac o menu é necessário para Cmd+C/Cmd+V/Cmd+Q; no Windows e Linux a janela fica sem menu
    ocrFontPath = await findFontFile(FONT_FILES.Arial[0]);
    for (const p of SRGB_CANDIDATES) { try { await fs.access(p); srgbPath = p; break; } catch { /* próximo */ } }
    Menu.setApplicationMenu(IS_MAC ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
    const file = fileArgFrom(process.argv);
    if (file) {
      try { pendingFile = await readUserFile(file); } catch { pendingFile = null; }
    }
    createWindow();
  });

  // Mac: arquivo aberto pelo Finder ("Abrir com" / duplo clique)
  app.on('open-file', async (event, filePath) => {
    event.preventDefault();
    try {
      const file = await readUserFile(filePath);
      if (win && !win.webContents.isLoading()) win.webContents.send('file:opened', file);
      else pendingFile = file;
    } catch { /* arquivo inacessível */ }
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
ipcMain.on('app:setLang', (_e, value) => { lang = value === 'en' ? 'en' : 'pt'; });

ipcMain.handle('file:open', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: tr('Abrir'),
    filters: [
      { name: tr('PDF e imagens'), extensions: ['pdf', ...IMAGE_EXT] },
      { name: 'PDF', extensions: ['pdf'] },
      { name: tr('Imagens'), extensions: IMAGE_EXT },
    ],
    properties: ['openFile', 'multiSelections'],
  });
  if (r.canceled || !r.filePaths.length) return [];
  return Promise.all(r.filePaths.map(readUserFile));
});

// kind: 'image' (uma imagem), 'images' (várias imagens) ou qualquer outro (PDFs e imagens)
ipcMain.handle('file:pickMany', async (_e, kind) => {
  const onlyImages = kind === 'image' || kind === 'images';
  const onlyPdf = kind === 'pdf';
  const r = await dialog.showOpenDialog(win, {
    title: tr(onlyImages ? 'Escolher imagem' : onlyPdf ? 'Abrir' : 'Inserir páginas'),
    filters: onlyImages ? [{ name: tr('Imagens'), extensions: IMAGE_EXT }] : onlyPdf ? [{ name: 'PDF', extensions: ['pdf'] }] : [{ name: tr('PDF e imagens'), extensions: ['pdf', ...IMAGE_EXT] }],
    properties: kind === 'image' || onlyPdf ? ['openFile'] : ['openFile', 'multiSelections'],
  });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map(readUserFile));
});

ipcMain.on('file:dropped', (_e, filePath) => { if (typeof filePath === 'string' && filePath) deliveredPaths.add(filePath); });

ipcMain.handle('file:noteOpened', (_e, filePath) => {
  if (deliveredPaths.has(filePath) || writablePaths.has(filePath)) return addRecent(filePath);
  return null;
});

ipcMain.handle('recent:list', async () => {
  const list = await readRecent();
  const out = [];
  for (const r of list) {
    try { await fs.access(r.path); out.push(r); } catch { /* arquivo apagado ou movido */ }
  }
  return out;
});

ipcMain.handle('recent:open', async (_e, filePath) => {
  const list = await readRecent();
  if (!list.some((r) => r.path === filePath)) return null;
  return readUserFile(filePath);
});

ipcMain.handle('recent:clear', async () => {
  try { await fs.unlink(recentFile()); } catch { /* já vazio */ }
  app.clearRecentDocuments();
  return true;
});

async function writeAtomic(target, data) {
  const tmp = target + '.tmp-' + process.pid;
  await fs.writeFile(tmp, Buffer.from(data));
  await fs.rename(tmp, target);
}

ipcMain.handle('pdf:save', async (_e, data, opts = {}) => {
  let target = opts.path && writablePaths.has(opts.path) && !opts.saveAs ? opts.path : null;
  if (selftestDir && opts.selftestName) target = path.join(selftestDir, path.basename(opts.selftestName));
  if (!target) {
    const r = await dialog.showSaveDialog(win, {
      title: opts.title || tr('Salvar PDF'),
      defaultPath: opts.suggestedPath || 'documento.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath.toLowerCase().endsWith('.pdf') ? r.filePath : r.filePath + '.pdf';
    writablePaths.add(target);
  }
  await writeAtomic(target, data);
  addRecent(target);
  return { path: target, name: path.basename(target) };
});

// Exportar um arquivo de outro tipo (Word, texto, imagem)
ipcMain.handle('file:saveAs', async (_e, data, opts = {}) => {
  let target;
  if (selftestDir && opts.selftestName) {
    target = path.join(selftestDir, path.basename(opts.selftestName));
  } else {
    const ext = (opts.ext || 'bin').replace(/[^a-z0-9]/gi, '');
    const r = await dialog.showSaveDialog(win, {
      title: opts.title || tr('Exportar'),
      defaultPath: opts.suggestedPath || `documento.${ext}`,
      filters: [{ name: opts.filterName || ext.toUpperCase(), extensions: [ext] }],
    });
    if (r.canceled || !r.filePath) return null;
    target = extOf(r.filePath) === ext ? r.filePath : `${r.filePath}.${ext}`;
  }
  await writeAtomic(target, data);
  writablePaths.add(target);
  return { path: target, name: path.basename(target) };
});

// Exportar vários arquivos (dividir PDF, páginas como imagem) para uma pasta escolhida
ipcMain.handle('dir:pick', async (_e, title) => {
  if (selftestDir) {
    const dir = path.join(selftestDir, 'export');
    await fs.mkdir(dir, { recursive: true });
    writableDirs.add(dir);
    return dir;
  }
  const r = await dialog.showOpenDialog(win, { title: title || tr('Escolher pasta'), properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  writableDirs.add(r.filePaths[0]);
  return r.filePaths[0];
});

ipcMain.handle('dir:write', async (_e, dir, files) => {
  if (!writableDirs.has(dir)) throw new Error('pasta não autorizada');
  const written = [];
  for (const f of files) {
    const name = path.basename(String(f.name)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
    let target = path.join(dir, name);
    // não sobrescreve: acrescenta (2), (3)...
    for (let n = 2; ; n++) {
      try { await fs.access(target); } catch { break; }
      target = path.join(dir, name.replace(/(\.[^.]+)?$/, ` (${n})$1`));
    }
    await fs.writeFile(target, Buffer.from(f.data));
    written.push(target);
  }
  return written;
});

ipcMain.handle('shell:show', (_e, target) => {
  if (writablePaths.has(target) || writableDirs.has(target)) shell.showItemInFolder(target);
  else if ([...writableDirs].some((d) => target.startsWith(d + path.sep))) shell.showItemInFolder(target);
});

ipcMain.handle('engine', async (_e, op, args) => {
  if (!ENGINE_OPS.has(op)) throw new Error('operação não permitida');
  return engineCall(op, args);
});

ipcMain.handle('print', async () => {
  return new Promise((resolve) => {
    win.webContents.print({ silent: false, printBackground: true }, (ok, reason) => resolve({ ok, reason }));
  });
});

ipcMain.handle('font:get', async (_e, family, variant) => {
  const files = FONT_FILES[family];
  if (!files) return null;
  for (const name of [files[Math.max(0, Math.min(3, variant | 0))], files[0]]) {
    const p = await findFontFile(name);
    if (p) return new Uint8Array(await fs.readFile(p));
  }
  return null;
});

ipcMain.handle('font:families', async () => {
  const available = [];
  for (const [family, files] of Object.entries(FONT_FILES)) {
    if (await findFontFile(files[0])) available.push({ family, script: SCRIPT_FONTS.includes(family) });
  }
  return available;
});

// ---------- autoteste (npm run selftest) ----------

ipcMain.handle('test:config', async () => {
  if (!selftestDir) return null;
  const fixtures = path.resolve('test-fixtures');
  const read = (name) => readUserFile(path.join(fixtures, name));
  return {
    lang: selftestLang,
    main: await read('contrato.pdf'),
    extra: await read('anexo.pdf'),
    locked: await read('protegido.pdf'),
    image: await read('logo.png'),
    scan: await read('escaneado.pdf'),
    big: await read('grande.pdf'),
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
