// App: abas (Início, Arquivos, Ferramentas, Ajustes) e a ligação com o editor.
import '@fontsource/sora/700.css';
import '@fontsource/sora/800.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import './style.css';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';
import { t, getLang, setLang } from './i18n.js';
import { icon } from './icons.js';
import { $, h, esc, sheet, confirmSheet, promptSheet, toast, busy, pickFiles, formatSize, formatWhen, pagesLabel } from './ui.js';
import { listDocs, readDoc, deleteDoc, renameDoc, shareDoc, saveDoc, openExternal, printPdf } from './storage.js';
import { openEditor, editorIsOpen, editorBack } from './editor.js';
import { mergePdfs, imagesToPdf, loadPdf, thumbnail } from './pdf.js';
import { savedSignature, clearSignature } from './signature.js';
import { TOOL_GROUPS, TOOL_ACTIONS, setupTools, ensureUnlocked } from './tools.js';

const VERSION = '1.0.0';
const SITE = 'https://cybersecinfo.com/';
const INSTAGRAM = 'https://www.instagram.com/cyber_secinfo/';

const app = $('#app');
let tab = 'home';

// ---------- Abrir arquivos ----------
// ensureUnlocked marca os bytes destravados com a senha usada; o editor protege de novo ao salvar
const protectionOf = (bytes) => (bytes.password ? { password: bytes.password } : null);
const EDITOR_MODES = { edittext: 'edit', forms: 'forms', redact: 'redact' };
async function openFromDevice(mode = 'annotate') {
  const [file] = await pickFiles({ accept: 'application/pdf' });
  if (!file) return;
  const bytes = await ensureUnlocked(new Uint8Array(await file.arrayBuffer()), file.name);
  if (!bytes) return;
  await openEditor({ name: file.name, bytes, mode, protection: protectionOf(bytes), onExit: render });
}

async function openFromLibrary(meta, mode = 'annotate') {
  const bytes = await ensureUnlocked(await readDoc(meta), meta.name);
  if (!bytes) return;
  await openEditor({ name: meta.name, id: meta.id, bytes, mode, protection: protectionOf(bytes), onExit: render });
}

// Salva um PDF novo na biblioteca (juntar, imagens) e abre no editor
async function storeAndOpen(bytes, name) {
  const pdf = await loadPdf(bytes);
  const meta = await saveDoc({ name, bytes, pages: pdf.numPages, thumb: await thumbnail(pdf) });
  pdf.loadingTask?.destroy?.();
  await openFromLibrary(meta);
}

async function mergeFlow() {
  const files = await pickFiles({ accept: 'application/pdf', multiple: true });
  if (!files.length) return;
  if (files.length < 2) return toast(t('Escolha ao menos dois PDFs.'));
  const stop = busy(t('Juntando…'));
  try {
    const bytes = await mergePdfs(await Promise.all(files.map(async (f) => new Uint8Array(await f.arrayBuffer()))));
    stop();
    await storeAndOpen(bytes, `${files[0].name.replace(/\.pdf$/i, '')} + ${files.length - 1}`);
  } catch {
    stop();
    toast(t('Não foi possível abrir este arquivo.'), 'error');
  }
}

async function imagesFlow() {
  const files = await pickFiles({ accept: 'image/*', multiple: true });
  if (!files.length) return;
  const stop = busy(t('Criando PDF…'));
  try {
    const bytes = await imagesToPdf(files);
    stop();
    const d = new Date();
    await storeAndOpen(bytes, `${t('Imagens em PDF')} ${d.toLocaleDateString().replace(/\//g, '-')}`);
  } catch {
    stop();
    toast(t('Não foi possível abrir este arquivo.'), 'error');
  }
}

// ---------- Itens de lista ----------
function docRow(d) {
  return `<li class="doc" data-id="${esc(d.id)}">
    <button class="doc-open" data-open>
      <span class="doc-thumb">${d.thumb ? `<img src="${d.thumb}" alt="">` : icon('file', { size: 26 })}</span>
      <span class="doc-info"><strong>${esc(d.name)}</strong><small>${pagesLabel(d.pages)} · ${formatSize(d.size)}</small><small class="when">${icon('clock', { size: 13 })}${formatWhen(d.updated)}</small></span>
    </button>
    <button class="icon-btn" data-more aria-label="${t('Mais opções')}">${icon('more')}</button>
  </li>`;
}

function emptyState() {
  return `<div class="empty">
    <div class="empty-art">${icon('file', { size: 34 })}</div>
    <h3>${t('Nenhum PDF por aqui ainda')}</h3>
    <p>${t('Abra um PDF do celular para editar, assinar ou organizar as páginas.')}</p>
    <button class="btn btn-primary" data-act="open">${icon('plus', { size: 18, stroke: 2.4 })}<span>${t('Abrir PDF')}</span></button>
  </div>`;
}

async function docMenu(meta) {
  const s = sheet(`<ul class="menu">
    <li><button data-m="share">${icon('share')}<span>${t('Compartilhar')}</span></button></li>
    <li><button data-m="print">${icon('printer')}<span>${t('Imprimir')}</span></button></li>
    <li><button data-m="sign">${icon('signature')}<span>${t('Assinar')}</span></button></li>
    <li><button data-m="pages">${icon('pages')}<span>${t('Organizar páginas')}</span></button></li>
    <li><button data-m="rename">${icon('type')}<span>${t('Renomear')}</span></button></li>
    <li><button data-m="del" class="danger">${icon('trash')}<span>${t('Excluir')}</span></button></li>
  </ul>`, { title: meta.name });
  s.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    s.close();
    const m = b.dataset.m;
    if (m === 'share') { try { await shareDoc(meta); } catch {} }
    else if (m === 'print') {
      const bytes = await ensureUnlocked(await readDoc(meta), meta.name);
      if (bytes) { try { await printPdf(bytes, meta.name); } catch { toast(t('Não foi possível imprimir.'), 'error'); } }
    } else if (m === 'sign') openFromLibrary(meta, 'sign');
    else if (m === 'pages') openFromLibrary(meta, 'pages');
    else if (m === 'rename') {
      const name = await promptSheet({ title: t('Renomear'), label: t('Nome do arquivo'), value: meta.name.replace(/\.pdf$/i, '') });
      if (name) { renameDoc(meta, name); render(); }
    } else if (m === 'del') {
      const ok = await confirmSheet({ title: t('Excluir este arquivo?'), text: t('Ele será apagado do app. Esta ação não pode ser desfeita.'), ok: t('Excluir'), danger: true });
      if (ok) { await deleteDoc(meta); render(); }
    }
  });
}

// ---------- Telas ----------
const QUICK = [
  ['annotate', 'highlighter', 'Anotar'],
  ['sign', 'signature', 'Assinar'],
  ['merge', 'merge', 'Juntar PDFs'],
  ['images', 'images', 'Imagens em PDF'],
];

function homeView() {
  const docs = listDocs();
  return `<div class="screen home">
    <header class="hero">
      <div class="hero-row">
        <img class="hero-icon" src="img/icon.png" alt="">
        <span class="hero-name">Editor PDF</span>
        <button class="pill" data-act="lang">${icon('globe', { size: 15 })}<span>${getLang().toUpperCase()}</span></button>
      </div>
      <h1>${t('Edite, assine e organize seus PDFs')}</h1>
      <p>${t('Tudo no seu celular, sem enviar seus documentos para a internet.')}</p>
      <button class="hero-cta" data-act="open">${icon('plus', { size: 20, stroke: 2.4 })}<span>${t('Abrir PDF')}</span></button>
    </header>
    <div class="body">
      <h2 class="sec">${t('Atalhos')}</h2>
      <div class="quick">${QUICK.map(([id, ic, label]) => `<button class="qcell" data-quick="${id}"><span class="qdisc">${icon(ic, { size: 22 })}</span><span>${t(label)}</span></button>`).join('')}</div>
      <div class="sec-row"><h2 class="sec">${t('Recentes')}</h2>${docs.length > 3 ? `<button class="link" data-tab="files">${t('ver todos')}</button>` : ''}</div>
      <div class="recents">${docs.length ? `<ul class="docs">${docs.slice(0, 12).map(docRow).join('')}</ul>` : emptyState()}</div>
      <div class="brand-card">
        <img src="img/emblem.png" alt="CyberSecInfo">
        <div class="bc-txt">
          <small>${t('Feito por')}</small><strong>CyberSecInfo</strong>
          <div class="links">
            <button class="linkbtn" data-url="${SITE}">${icon('globe', { size: 16 })}<span>cybersecinfo.com</span></button>
            <button class="linkbtn" data-url="${INSTAGRAM}">${icon('instagram', { size: 16 })}<span>@cyber_secinfo</span></button>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function filesView() {
  const docs = listDocs();
  return `<div class="screen">
    <header class="plain-head"><h1>${t('Seus arquivos')}</h1><p>${t('Os PDFs que você salvar no app ficam aqui.')}</p></header>
    <div class="body">${docs.length ? `<ul class="docs">${docs.map(docRow).join('')}</ul>` : emptyState()}</div>
  </div>`;
}

function toolsView() {
  return `<div class="screen">
    <header class="plain-head"><h1>${t('Ferramentas')}</h1></header>
    <div class="body">${TOOL_GROUPS.map(([group, items]) => `<h2 class="tool-group">${t(group)}</h2>
      <ul class="rows">${items.map(([id, ic, title, sub]) => `<li><button class="row" data-quick="${id}"><span class="row-ic">${icon(ic)}</span><span class="row-txt"><strong>${t(title)}</strong><small>${t(sub)}</small></span>${icon('chevronRight', { size: 20, cls: 'chev' })}</button></li>`).join('')}</ul>`).join('')}
    </div>
  </div>`;
}

function settingsView() {
  const sig = savedSignature();
  return `<div class="screen">
    <header class="plain-head"><h1>${t('Ajustes')}</h1></header>
    <div class="body">
      <h2 class="sec">${t('Idioma')}</h2>
      <div class="seg" role="radiogroup">
        <button role="radio" data-lang="pt" aria-checked="${getLang() === 'pt'}">Português</button>
        <button role="radio" data-lang="en" aria-checked="${getLang() === 'en'}">English</button>
      </div>
      <h2 class="sec">${t('Assinatura salva')}</h2>
      <div class="card sig-card">${sig ? `<img src="${sig}" alt="${t('Assinatura salva')}"><button class="btn btn-text danger" data-act="clear-sig">${t('Apagar assinatura salva')}</button>` : `<p class="muted">${t('Nenhuma assinatura salva')}</p>`}</div>
      <h2 class="sec">${t('Sobre')}</h2>
      <div class="card about">
        <img class="emblem" src="img/emblem.png" alt="CyberSecInfo">
        <strong>Editor PDF</strong>
        <small>${t('Versão {v}', { v: VERSION })} · ${t('por CyberSecInfo — Information Security')}</small>
        <p class="privacy">${icon('shield', { size: 16 })}<span>${t('Seus documentos não saem do aparelho.')}</span></p>
        <div class="links">
          <button class="linkbtn" data-url="${SITE}">${icon('globe', { size: 18 })}<span>cybersecinfo.com</span></button>
          <button class="linkbtn" data-url="${INSTAGRAM}">${icon('instagram', { size: 18 })}<span>@cyber_secinfo</span></button>
        </div>
      </div>
    </div>
  </div>`;
}

const TABS = [
  ['home', 'home', 'Início'],
  ['files', 'folder', 'Arquivos'],
  ['open', 'plus', 'Abrir'],
  ['tools', 'grid', 'Ferramentas'],
  ['settings', 'sliders', 'Ajustes'],
];

function render() {
  const view = { home: homeView, files: filesView, tools: toolsView, settings: settingsView }[tab]();
  app.innerHTML = `<main class="main">${view}</main>
    <nav class="tabbar">${TABS.map(([id, ic, label]) => id === 'open'
      ? `<button class="tab center" data-act="open" aria-label="${t('Abrir PDF')}"><span class="fab">${icon('plus', { size: 26, stroke: 2.4 })}</span><span>${t(label)}</span></button>`
      : `<button class="tab ${tab === id ? 'on' : ''}" data-tab="${id}" ${tab === id ? 'aria-current="page"' : ''}>${icon(ic, { size: 23 })}<span>${t(label)}</span></button>`).join('')}</nav>`;
  document.body.dataset.tab = tab;
}

app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-tab],[data-act],[data-quick],[data-open],[data-more],[data-lang],[data-url]');
  if (!el) return;
  if (el.dataset.tab) { tab = el.dataset.tab; render(); $('.main')?.scrollTo(0, 0); return; }
  if (el.dataset.url) return openExternal(el.dataset.url);
  if (el.dataset.lang) { setLang(el.dataset.lang); render(); return; }
  const docEl = el.closest('.doc');
  const meta = docEl && listDocs().find((d) => d.id === docEl.dataset.id);
  if (el.hasAttribute('data-open') && meta) return openFromLibrary(meta);
  if (el.hasAttribute('data-more') && meta) return docMenu(meta);
  const q = el.dataset.quick;
  if (q === 'merge') return mergeFlow();
  if (q === 'images') return imagesFlow();
  if (TOOL_ACTIONS[q]) return TOOL_ACTIONS[q]();
  if (q) return openFromDevice(EDITOR_MODES[q] || q);
  const act = el.dataset.act;
  if (act === 'open') return openFromDevice();
  if (act === 'lang') { setLang(getLang() === 'pt' ? 'en' : 'pt'); render(); }
  if (act === 'clear-sig') { clearSignature(); render(); }
});

// ---------- Início ----------
setupTools({ openMeta: (meta) => openFromLibrary(meta), refresh: () => { if (!editorIsOpen()) render(); } });
setLang(getLang());
render();

if (Capacitor.isNativePlatform()) {
  // Topo vermelho nas abas (texto claro); editor tem topo branco (texto escuro)
  const syncBar = () => StatusBar.setStyle({ style: document.body.classList.contains('editing') ? Style.Light : Style.Dark }).catch(() => {});
  syncBar();
  new MutationObserver(syncBar).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  App.addListener('backButton', () => {
    const open = document.querySelector('.sheet-root.open .sheet-backdrop');
    if (open) return open.click();
    if (editorIsOpen()) return editorBack();
    if (tab !== 'home') { tab = 'home'; render(); return; }
    App.exitApp();
  });
}
