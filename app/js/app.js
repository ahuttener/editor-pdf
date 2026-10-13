import { pdfjs, fabric, PDFLib, loadPdfjsDocument, newUid } from './libs.js';
import { buildPdf, collectRedactions, permissionsFrom } from './save.js';
import { readFormFields, renderFormLayer } from './forms.js';
import { loadTextRuns, createTextEdit, renderTextHits, groupParagraphs, createParagraphEdit } from './textedit.js';
import { askPassword, confirmDialog, choiceDialog, isDialogOpen } from './dialogs.js';
import { setupFeatures } from './features.js';
import { t, translateDom, setLang, getLang } from './i18n.js';

const api = window.api;
const $ = (sel) => document.querySelector(sel);
const viewerEl = $('#viewer');
const pagesEl = $('#pages');
const thumbsEl = $('#thumbs');

const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const DRAG_TOOLS = ['whiteout', 'highlight', 'rect', 'redact', 'ellipse', 'line', 'arrow', 'underline', 'strike', 'field-text', 'field-check', 'field-list'];
const CLICK_TOOLS = ['text', 'note', 'stamp'];
const IMAGE_MIME = /^image\//;

const state = {
  docs: new Map(),     // chave -> { bytes, pdf (pdf.js), name }
  pages: [],           // páginas na ordem final
  selected: new Set(), // ids de páginas selecionadas na barra lateral
  formFields: [],
  meta: {},
  protection: null,    // { user, owner, permissions, noPrint, noCopy, noEdit }
  sanitize: false,
  hf: null,            // configuração de cabeçalho e rodapé
  file: null,          // { path, name } do arquivo aberto
  savedPath: null,
  zoom: 1,
  tool: 'select',
  pendingStamp: null,
  dirty: false,
  current: null,
  history: [],
  redo: [],
  suspend: 0,
  nextDoc: 1,
  nextPage: 1,
  textStyle: { fontFamily: 'Arial', fontSize: 14, fill: '#000000', bold: false, italic: false, underline: false, align: 'left' },
  stroke: { width: 2, color: '#d32f2f', opacity: 1 },
  fonts: [],
  lastSavedBytes: null,
};

// ---------- utilidades de interface ----------

let toastTimer = null;
function toast(message, isError = false, action = null) {
  const el = $('#toast');
  el.replaceChildren(document.createTextNode(t(message)));
  if (action) {
    const b = document.createElement('button');
    b.textContent = t(action.label);
    b.onclick = () => { el.hidden = true; action.run(); };
    el.append(b);
  }
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 7000 : action ? 6000 : 2800);
}

function busy(message) {
  $('#busy').hidden = !message;
  if (message) $('#busy-text').textContent = t(message);
}

function setDirty(value) {
  state.dirty = value;
  api.setDirty(value);
  updateTitle();
}

function updateTitle() {
  const name = state.file?.name || 'Editor PDF';
  document.title = `${state.dirty ? '• ' : ''}${name} — Editor PDF`;
}

const hasDoc = () => state.pages.length > 0;

function updateButtons() {
  const open = hasDoc();
  for (const id of ['#btn-save', '#btn-saveas', '#btn-print', '#btn-search']) $(id).disabled = !open;
  $('#btn-undo').disabled = !state.history.length;
  $('#btn-redo').disabled = !state.redo.length;
  $('#empty').hidden = open;
  const p = state.protection;
  $('#protect-status').textContent = p ? t('Senha ativa{extra} — será aplicada ao salvar.', { extra: p.noPrint || p.noCopy || p.noEdit ? t(' com restrições') : '' }) : '';
}

const formatBytes = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const baseName = () => (state.file?.name || 'documento.pdf').replace(/\.[^.]+$/, '');

// ---------- páginas ----------
// Em documentos grandes, a camada de edição (fabric) de cada página só existe enquanto a página
// está perto da tela; longe dela, as edições ficam guardadas em entry.lastJson.
const LAZY_FROM = 30; // a partir de quantas páginas
const isLazy = () => state.pages.length > LAZY_FROM;
const EMPTY_JSON = JSON.stringify({ objects: [] });

// Imagens (data URLs grandes) ficam fora do histórico: o snapshot guarda só uma chave
const imageKeys = new Map(); // dataURL -> chave
const imageStore = new Map(); // chave -> dataURL

function walkObjects(list, fn) {
  for (const o of list || []) { fn(o); if (o.objects) walkObjects(o.objects, fn); }
}
function dehydrate(json) {
  walkObjects(json.objects, (o) => {
    if (typeof o.src === 'string' && o.src.startsWith('data:')) {
      let key = imageKeys.get(o.src);
      if (!key) { key = `img:${imageKeys.size + 1}`; imageKeys.set(o.src, key); imageStore.set(key, o.src); }
      o.src = key;
    }
  });
  return json;
}
function hydrate(jsonText) {
  const json = JSON.parse(jsonText);
  walkObjects(json.objects, (o) => { if (typeof o.src === 'string' && imageStore.has(o.src)) o.src = imageStore.get(o.src); });
  return json;
}

function makeEntry(docKey, index, proxy) {
  return {
    id: state.nextPage++,
    docKey,
    index,
    proxy,
    baseRot: proxy.rotate || 0,
    extraRot: 0,
    el: null, pdfCanvas: null, fabric: null, fabricHost: null, hitLayer: null, formLayer: null, searchLayer: null,
    runs: null, renderTask: null, renderedKey: null, visible: false, lastJson: EMPTY_JSON, thumb: null,
    thumbTask: null, thumbDone: false, materializing: null, hfStale: false,
    rotation() { return (this.baseRot + this.extraRot) % 360; },
    viewport(scale = 1) { return this.proxy.getViewport({ scale, rotation: this.rotation() }); },
    // Objetos de edição da página, mesmo quando a camada não está montada (para salvar)
    async objects() {
      if (this.fabric) return this.fabric.getObjects();
      const json = hydrate(this.lastJson);
      return json.objects?.length ? fabric.util.enlivenObjects(json.objects) : [];
    },
    // Objetos "crus" (sem montar), para listas como a de comentários
    plainObjects() {
      return this.fabric ? this.fabric.getObjects() : JSON.parse(this.lastJson).objects || [];
    },
  };
}

const observer = new IntersectionObserver((records) => {
  for (const r of records) {
    const entry = state.pages.find((e) => e.el === r.target);
    if (!entry) continue;
    entry.visible = r.isIntersecting;
    if (r.isIntersecting) {
      renderPage(entry);
      if (!entry.fabric) materialize(entry);
    } else {
      releasePixels(entry);
    }
  }
}, { root: viewerEl, rootMargin: '800px 0px' });

// Bem longe da tela: devolve a memória da camada de edição (só em documentos grandes)
const farObserver = new IntersectionObserver((records) => {
  if (!isLazy()) return;
  for (const r of records) {
    if (r.isIntersecting) continue;
    const entry = state.pages.find((e) => e.el === r.target);
    if (entry) dematerialize(entry);
  }
}, { root: viewerEl, rootMargin: '3000px 0px' });

// Miniaturas só são desenhadas quando aparecem na barra lateral
const thumbObserver = new IntersectionObserver((records) => {
  for (const r of records) {
    if (!r.isIntersecting) continue;
    const entry = state.pages.find((e) => e.thumb === r.target);
    if (entry && !entry.thumbDone) renderThumb(entry);
  }
}, { root: thumbsEl, rootMargin: '600px 0px' });

function releasePixels(entry) {
  entry.renderTask?.cancel();
  entry.renderTask = null;
  entry.renderedKey = null;
  entry.pdfCanvas.width = 0;
  entry.pdfCanvas.height = 0;
}

function buildPageDom(entry) {
  const el = document.createElement('div');
  el.className = 'page';
  const pdfCanvas = document.createElement('canvas');
  pdfCanvas.className = 'pdf';
  const fabricHost = document.createElement('div');
  fabricHost.className = 'fabric-host';
  const searchLayer = document.createElement('div');
  searchLayer.className = 'search-layer';
  const hitLayer = document.createElement('div');
  hitLayer.className = 'text-hits';
  const formLayer = document.createElement('div');
  formLayer.className = 'form-layer';
  const label = document.createElement('div');
  label.className = 'page-label';
  el.append(pdfCanvas, fabricHost, searchLayer, hitLayer, formLayer, label);
  pagesEl.append(el);
  Object.assign(entry, { el, pdfCanvas, fabricHost, hitLayer, formLayer, searchLayer, label });
  if (!isLazy()) createFabric(entry);
  sizePage(entry);
  observer.observe(el);
  farObserver.observe(el);
  el.addEventListener('mousedown', () => setCurrent(entry), true);
}

function createFabric(entry) {
  const canvasEl = document.createElement('canvas');
  entry.fabricHost.append(canvasEl);
  const vp = entry.viewport();
  entry.fabric = new fabric.Canvas(canvasEl, {
    width: vp.width * state.zoom,
    height: vp.height * state.zoom,
    preserveObjectStacking: true,
    selection: true,
    stopContextMenu: true,
    targetFindTolerance: 4,
  });
  entry.fabric.setZoom(state.zoom);
  wireCanvas(entry);
  applyToolTo(entry);
  return entry.fabric;
}

async function loadInto(entry, jsonText) {
  state.suspend++;
  try {
    await entry.fabric.loadFromJSON(hydrate(jsonText));
    entry.fabric.getObjects().forEach(normalizeObject);
    entry.fabric.requestRenderAll();
  } finally {
    state.suspend--;
  }
}

// Monta a camada de edição de uma página (com as edições guardadas)
function materialize(entry) {
  if (entry.materializing) return entry.materializing;
  if (entry.fabric) return Promise.resolve(entry.fabric);
  createFabric(entry);
  const run = (async () => {
    if (entry.lastJson !== EMPTY_JSON) await loadInto(entry, entry.lastJson);
    if (entry.hfStale) { features?.refreshHeaderFooter(entry); entry.lastJson = snapshot(entry); }
    if (isTextTool()) renderHits(entry);
    return entry.fabric;
  })();
  entry.materializing = run;
  // limpa a marcação depois da atribuição (a montagem pode terminar sem esperar nada)
  run.finally(() => { if (entry.materializing === run) entry.materializing = null; }).catch(() => {});
  return run;
}

function dematerialize(entry) {
  const c = entry.fabric;
  if (!c || entry.materializing || c.getActiveObject()?.isEditing || drag?.entry === entry) return;
  c.discardActiveObject();
  entry.lastJson = snapshot(entry);
  entry.fabric = null;
  c.dispose();
  entry.fabricHost.replaceChildren();
}

// Depois de operações em lote (marca d'água, salvar...), solta as páginas que estão longe da tela
function trimMemory() {
  if (!isLazy()) return;
  for (const e of state.pages) if (!e.visible) dematerialize(e);
}

function sizePage(entry) {
  const vp = entry.viewport();
  const w = vp.width * state.zoom;
  const h = vp.height * state.zoom;
  entry.el.style.width = `${w}px`;
  entry.el.style.height = `${h}px`;
  entry.pdfCanvas.style.width = `${w}px`;
  entry.pdfCanvas.style.height = `${h}px`;
  if (entry.fabric) {
    entry.fabric.setDimensions({ width: w, height: h });
    entry.fabric.setZoom(state.zoom);
    entry.fabric.calcOffset();
  }
  entry.renderedKey = null;
  renderFormLayer(entry, state.formFields, state.zoom, () => setDirty(true));
  if (isTextTool()) renderHits(entry);
  else entry.hitLayer.replaceChildren();
  features?.renderSearch(entry);
  if (entry.visible) renderPage(entry);
}

async function renderPage(entry) {
  const dpr = window.devicePixelRatio || 1;
  const key = `${state.zoom}|${entry.rotation()}|${dpr}|${entry.proxyVersion || 0}`;
  if (entry.renderedKey === key) return;
  entry.renderedKey = key;
  if (entry.renderTask) entry.renderTask.cancel();
  const vp = entry.viewport(state.zoom * dpr);
  const off = document.createElement('canvas');
  off.width = Math.floor(vp.width);
  off.height = Math.floor(vp.height);
  const task = entry.proxy.render({
    canvas: off,
    viewport: vp,
    annotationMode: entry.docKey === 'main' && state.formFields.length ? pdfjs.AnnotationMode.ENABLE_FORMS : pdfjs.AnnotationMode.ENABLE,
  });
  entry.renderTask = task;
  try {
    await task.promise;
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') console.error(err);
    return;
  }
  if (entry.renderTask !== task) return;
  entry.renderTask = null;
  entry.pdfCanvas.width = off.width;
  entry.pdfCanvas.height = off.height;
  entry.pdfCanvas.getContext('2d').drawImage(off, 0, 0);
}

function layoutPages() {
  state.pages.forEach((entry, i) => {
    pagesEl.append(entry.el);
    entry.label.textContent = t('Página {n}', { n: i + 1 });
    if (!entry.thumb) buildThumb(entry);
    thumbsEl.append(entry.thumb);
    entry.thumb.querySelector('.num').textContent = String(i + 1);
    entry.thumb.classList.toggle('selected', state.selected.has(entry.id));
  });
  for (const entry of state.pages) entry.fabric?.calcOffset();
  features?.refreshHeaderFooter();
  updateButtons();
}

function buildThumb(entry) {
  const li = document.createElement('li');
  li.className = 'thumb';
  li.draggable = true;
  const canvas = document.createElement('canvas');
  const num = document.createElement('div');
  num.className = 'num';
  const actions = document.createElement('div');
  actions.className = 'actions';
  const mk = (label, title, cls, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = t(title);
    b.dataset.title = title;
    if (cls) b.className = cls;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  };
  actions.append(
    mk('⟲', 'Girar para a esquerda', '', () => rotatePage(entry, -1)),
    mk('⟳', 'Girar para a direita', '', () => rotatePage(entry, 1)),
    mk('✕', 'Excluir página', 'del', () => deletePages([entry])),
  );
  li.append(canvas, num, actions);
  li.addEventListener('click', (e) => onThumbClick(entry, e));
  li.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-page', String(entry.id)); e.dataTransfer.effectAllowed = 'move'; });
  li.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/x-page')) return;
    e.preventDefault();
    li.classList.add('drag-over');
  });
  li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
  li.addEventListener('drop', (e) => {
    li.classList.remove('drag-over');
    const id = Number(e.dataTransfer.getData('text/x-page'));
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    const moving = state.pages.find((p) => p.id === id);
    if (!moving || moving === entry) return;
    const rect = li.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    const without = state.pages.filter((p) => p !== moving);
    movePage(moving, without.indexOf(entry) + (after ? 1 : 0));
  });
  entry.thumb = li;
  entry.thumbCanvas = canvas;
  // reserva o espaço da miniatura antes de desenhar, para a lista não "pular"
  const base = entry.viewport();
  const scale = 150 / Math.max(base.width, base.height);
  canvas.style.width = `${base.width * scale}px`;
  canvas.style.height = `${base.height * scale}px`;
  thumbObserver.observe(li);
}

let lastClicked = null;
function onThumbClick(entry, e) {
  if (e.ctrlKey || e.metaKey) {
    if (state.selected.has(entry.id)) state.selected.delete(entry.id); else state.selected.add(entry.id);
  } else if (e.shiftKey && lastClicked) {
    const a = state.pages.indexOf(lastClicked);
    const b = state.pages.indexOf(entry);
    state.selected = new Set(state.pages.slice(Math.min(a, b), Math.max(a, b) + 1).map((p) => p.id));
  } else {
    state.selected = new Set([entry.id]);
    entry.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  lastClicked = entry;
  setCurrent(entry);
  for (const p of state.pages) p.thumb?.classList.toggle('selected', state.selected.has(p.id));
}

// Páginas em que as ações de página atuam: as selecionadas, ou a atual
function targetPages() {
  const sel = state.pages.filter((p) => state.selected.has(p.id));
  if (sel.length) return sel;
  return state.current ? [state.current] : state.pages.slice(0, 1);
}

// Desenha a miniatura num canvas à parte e só troca no fim (girar rápido não embaralha)
async function renderThumb(entry) {
  entry.thumbTask?.cancel();
  const base = entry.viewport();
  const scale = 150 / Math.max(base.width, base.height);
  const vp = entry.viewport(scale * (window.devicePixelRatio || 1));
  const off = document.createElement('canvas');
  off.width = Math.floor(vp.width);
  off.height = Math.floor(vp.height);
  const task = entry.proxy.render({ canvas: off, viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE });
  entry.thumbTask = task;
  try {
    await task.promise;
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') console.error(err);
    return;
  }
  if (entry.thumbTask !== task) return;
  entry.thumbTask = null;
  const canvas = entry.thumbCanvas;
  canvas.width = off.width;
  canvas.height = off.height;
  canvas.style.width = `${base.width * scale}px`;
  canvas.style.height = `${base.height * scale}px`;
  canvas.getContext('2d').drawImage(off, 0, 0);
  entry.thumbDone = true;
}

function refreshThumb(entry) {
  entry.thumbDone = false;
  renderThumb(entry);
}

function setCurrent(entry) {
  if (state.current === entry) return;
  state.current = entry;
  for (const p of state.pages) p.thumb?.classList.toggle('current', p === entry);
}

function trackCurrentOnScroll() {
  const mid = viewerEl.getBoundingClientRect().top + viewerEl.clientHeight / 3;
  let best = null;
  let bestDist = Infinity;
  for (const p of state.pages) {
    const r = p.el.getBoundingClientRect();
    const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
    if (d < bestDist) { bestDist = d; best = p; }
  }
  if (best) setCurrent(best);
}

async function addDocPages(docKey, insertAt = state.pages.length) {
  const doc = state.docs.get(docKey);
  const entries = [];
  for (let i = 0; i < doc.pdf.numPages; i++) entries.push(makeEntry(docKey, i, await doc.pdf.getPage(i + 1)));
  state.pages.splice(insertAt, 0, ...entries);
  for (const e of entries) buildPageDom(e);
  layoutPages();
  return entries;
}

function movePage(entry, targetIndex) {
  const from = state.pages.indexOf(entry);
  state.pages.splice(from, 1);
  state.pages.splice(Math.max(0, Math.min(targetIndex, state.pages.length)), 0, entry);
  layoutPages();
  setDirty(true);
}

async function rotatePage(entry, dir) {
  if (!entry.fabric || entry.materializing) await materialize(entry);
  const old = entry.viewport();
  const canvas = entry.fabric;
  canvas.discardActiveObject();
  state.suspend++;
  for (const obj of canvas.getObjects()) {
    const c = obj.getCenterPoint();
    const next = dir > 0 ? new fabric.Point(old.height - c.y, c.x) : new fabric.Point(c.y, old.width - c.x);
    obj.set('angle', ((obj.angle || 0) + 90 * dir + 360) % 360);
    obj.setPositionByOrigin(next, 'center', 'center');
    obj.setCoords();
  }
  state.suspend--;
  entry.extraRot = (entry.extraRot + 90 * dir + 360) % 360;
  entry.runs = null;
  // os passos de desfazer anteriores estão em coordenadas antigas
  state.history = state.history.filter((h) => h.id !== entry.id);
  state.redo = state.redo.filter((h) => h.id !== entry.id);
  entry.lastJson = snapshot(entry);
  sizePage(entry);
  refreshThumb(entry);
  if (isTextTool()) ensureRuns(entry);
  features?.refreshHeaderFooter();
  setDirty(true);
  updateButtons();
}

function disposePage(entry) {
  observer.unobserve(entry.el);
  farObserver.unobserve(entry.el);
  if (entry.thumb) thumbObserver.unobserve(entry.thumb);
  entry.renderTask?.cancel();
  entry.thumbTask?.cancel();
  entry.fabric?.dispose();
  entry.fabric = null;
  entry.el.remove();
  entry.thumb?.remove();
}

function deletePages(entries) {
  const remaining = state.pages.filter((p) => !entries.includes(p));
  if (!remaining.length) { toast('O documento precisa ter pelo menos uma página.', true); return; }
  for (const entry of entries) {
    disposePage(entry);
    state.selected.delete(entry.id);
    state.history = state.history.filter((h) => h.id !== entry.id);
    state.redo = state.redo.filter((h) => h.id !== entry.id);
    if (state.current === entry) state.current = null;
  }
  state.pages = remaining;
  layoutPages();
  trackCurrentOnScroll();
  setDirty(true);
  toast(entries.length > 1 ? t('{n} páginas excluídas.', { n: entries.length }) : 'Página excluída.');
}

async function duplicatePages(entries) {
  for (const src of entries) {
    const json = snapshot(src);
    const copy = makeEntry(src.docKey, src.index, src.proxy);
    copy.extraRot = src.extraRot;
    state.pages.splice(state.pages.indexOf(src) + 1, 0, copy);
    buildPageDom(copy);
    await restore(copy, json);
  }
  layoutPages();
  setDirty(true);
}

// Troca os bytes de um documento (depois do OCR) e recarrega as páginas afetadas
async function replaceDocBytes(docKey, bytes) {
  const doc = state.docs.get(docKey);
  const pdf = await loadPdfjsDocument(bytes);
  doc.pdf.loadingTask.destroy();
  Object.assign(doc, { bytes, pdf });
  for (const entry of state.pages.filter((p) => p.docKey === docKey)) {
    entry.proxy = await pdf.getPage(entry.index + 1);
    entry.proxyVersion = (entry.proxyVersion || 0) + 1;
    entry.runs = null;
    entry.renderedKey = null;
    if (entry.visible) renderPage(entry);
    refreshThumb(entry);
  }
}

// ---------- abrir / inserir ----------

function resetDocument() {
  for (const p of state.pages) disposePage(p);
  for (const d of state.docs.values()) d.pdf.loadingTask.destroy();
  imageKeys.clear();
  imageStore.clear();
  Object.assign(state, {
    docs: new Map(), pages: [], selected: new Set(), formFields: [], meta: {}, protection: null, hf: null,
    file: null, savedPath: null, current: null, history: [], redo: [], nextDoc: 1,
  });
  features?.clearSearch();
}

// Senhas: devolve bytes sem criptografia (e a proteção a reaplicar ao salvar) ou null se cancelar
async function unlockIfNeeded(bytes, name) {
  const info = await api.engine('inspect', { bytes });
  if (!info.encrypted) return { bytes, protection: null };
  let message = t('"{nome}" é protegido por senha. Digite a senha para abrir.', { nome: name });
  if (info.needsPassword || !info.canEdit) {
    if (!info.needsPassword) message = t('"{nome}" tem restrições de edição. Digite a senha do proprietário para poder editar.', { nome: name });
    for (;;) {
      const password = await askPassword(message);
      if (password === null) return null;
      const r = await api.engine('unlock', { bytes, password });
      if (r.ok) {
        if (password.includes(',')) {
          toast('A senha deste PDF tem vírgula e não pode ser reaplicada: ele será salvo sem senha. Defina uma nova em Proteger → Senha e permissões.', true);
          return { bytes: r.bytes, protection: null };
        }
        let protection;
        if (!info.needsPassword) {
          // abre sem senha, mas tem restrições: mantém as restrições com a mesma senha do proprietário
          protection = { user: '', owner: password, permissions: r.permissions };
        } else if (r.level & 2) {
          // senha de usuário: a do proprietário (se diferente) não é conhecida; cria outra para manter as restrições
          protection = { user: password, owner: r.owner ? '' : randomPassword(), permissions: r.permissions };
        } else {
          // abriu com a senha do proprietário: a de usuário original não é conhecida
          protection = { user: password, owner: '', permissions: r.permissions };
          toast('Você abriu com a senha do proprietário: ao salvar, ela passa a ser a senha para abrir. Para mudar, use Proteger → Senha e permissões.');
        }
        return { bytes: r.bytes, protection };
      }
      message = r.reason === 'restricted'
        ? 'Essa senha abre o PDF, mas ele tem restrições de edição. Digite a senha do proprietário.'
        : 'Senha incorreta. Tente de novo.';
    }
  }
  const r = await api.engine('unlock', { bytes, password: '' });
  return r.ok ? { bytes: r.bytes, protection: null } : null;
}

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, 'x');
}

// Impede duas operações pesadas ao mesmo tempo (abrir, salvar, OCR...)
async function exclusive(fn) {
  if (state.working) { toast('Aguarde a operação atual terminar.'); return null; }
  state.working = true;
  try { return await fn(); } finally { state.working = false; }
}

async function readMeta(bytes) {
  try {
    const doc = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
    const lang = doc.catalog.get(PDFLib.PDFName.of('Lang'));
    return {
      title: doc.getTitle() || '', author: doc.getAuthor() || '', subject: doc.getSubject() || '', keywords: doc.getKeywords() || '',
      lang: lang?.decodeText ? lang.decodeText() : '',
    };
  } catch { return {}; }
}

// Converte imagens (qualquer formato que o navegador abra) num PDF, uma imagem por página
async function imagesToPdf(files) {
  const doc = await PDFLib.PDFDocument.create();
  for (const file of files) {
    const { dataUrl, width, height } = await toEmbeddableImage(file.data, file.mime);
    const image = dataUrl.startsWith('data:image/png') ? await doc.embedPng(dataUrl) : await doc.embedJpg(dataUrl);
    const scale = Math.min(1, 842 / Math.max(width * 0.75, height * 0.75));
    const w = width * 0.75 * scale;
    const h = height * 0.75 * scale;
    doc.addPage([w, h]).drawImage(image, { x: 0, y: 0, width: w, height: h });
  }
  return doc.save();
}

// PNG e JPG passam direto; outros formatos (WEBP, GIF, BMP, SVG) viram PNG
async function toEmbeddableImage(bytes, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let width = img.naturalWidth || 1000;
    let height = img.naturalHeight || 1000;
    if (mime === 'image/png' || mime === 'image/jpeg') {
      return { dataUrl: await blobToDataUrl(blob), width, height };
    }
    if (mime === 'image/svg+xml') { const s = 2000 / Math.max(width, height); width *= s; height *= s; }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width);
    canvas.height = Math.round(height);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Aceita PDFs e/ou imagens; abre o primeiro PDF e insere o resto
async function openFiles(files) {
  if (!files?.length) return;
  if (state.working) { toast('Aguarde a operação atual terminar.'); return; }
  if (state.dirty && !(await confirmDialog('Alterações não salvas', 'Abrir outro arquivo e descartar as alterações atuais?', 'Descartar e abrir'))) return;
  return exclusive(() => openFilesNow(files));
}

async function openFilesNow(files) {
  const images = files.filter((f) => IMAGE_MIME.test(f.mime || ''));
  const pdfs = files.filter((f) => !IMAGE_MIME.test(f.mime || ''));
  busy('Abrindo…');
  try {
    let first;
    let fromImages = false;
    if (pdfs.length) first = pdfs.shift();
    else fromImages = true, first = { name: images.length > 1 ? t('Imagens.pdf') : images[0].name.replace(/\.[^.]+$/, '.pdf'), path: null, data: await imagesToPdf(images.splice(0)) };
    const opened = await openPdf(first);
    if (!opened) return;
    const rest = [...pdfs];
    if (images.length) rest.push({ name: t('Imagens.pdf'), path: null, data: await imagesToPdf(images) });
    if (rest.length) await insertDocs(rest, { silent: true });
    setDirty(rest.length > 0 || fromImages);
  } catch (err) {
    console.error(err);
    toast(t('Não consegui abrir: {erro}', { erro: err?.message || err }), true);
  } finally {
    busy(false);
  }
}

async function openPdf(file) {
  let bytes = new Uint8Array(file.data);
  const unlocked = await unlockIfNeeded(bytes, file.name);
  if (!unlocked) { toast('Abertura cancelada.'); return false; }
  bytes = unlocked.bytes;
  const pdf = await loadPdfjsDocument(bytes);
  let forms = { fields: [] };
  try { forms = await readFormFields(bytes); } catch (err) { console.warn('Formulário não lido', err); }
  resetDocument();
  state.docs.set('main', { bytes, pdf, name: file.name });
  state.file = { path: file.path || null, name: file.name || 'documento.pdf' };
  state.formFields = forms.fields;
  state.meta = await readMeta(bytes);
  state.protection = unlocked.protection;
  await addDocPages('main');
  setCurrent(state.pages[0]);
  fitWidth();
  viewerEl.scrollTop = 0;
  setDirty(false);
  updateButtons();
  if (file.path) api.noteOpened(file.path);
  features?.loadOutline();
  features?.refreshComments();
  const notes = [];
  if (forms.fields.length) notes.push(t('{n} campo(s) de formulário para preencher', { n: forms.fields.length }));
  if (unlocked.protection) notes.push(t('a senha será mantida ao salvar'));
  if (notes.length) toast(t('Este PDF: {itens}.', { itens: notes.join('; ') }));
  return true;
}

async function insertDocs(files, opts = {}) {
  if (!files?.length) return [];
  if (opts.silent) return insertDocsNow(files, opts);
  return (await exclusive(() => insertDocsNow(files, opts))) || [];
}

async function insertDocsNow(files, { silent = false, at } = {}) {
  if (!silent) busy('Inserindo páginas…');
  const added = [];
  try {
    for (const file of files) {
      let bytes = IMAGE_MIME.test(file.mime || '') ? await imagesToPdf([file]) : new Uint8Array(file.data);
      const unlocked = await unlockIfNeeded(bytes, file.name);
      if (!unlocked) continue;
      bytes = unlocked.bytes;
      const key = `doc${state.nextDoc++}`;
      const pdf = await loadPdfjsDocument(bytes);
      state.docs.set(key, { bytes, pdf, name: file.name });
      added.push(...await addDocPages(key, at === undefined ? state.pages.length : at + added.length));
    }
    if (!silent) {
      setDirty(true);
      if (added[0]) { setCurrent(added[0]); added[0].el.scrollIntoView({ block: 'start' }); }
      toast(t('{n} página(s) inserida(s).', { n: added.length }));
    }
  } catch (err) {
    console.error(err);
    toast(t('Não consegui inserir: {erro}', { erro: err?.message || err }), true);
  } finally {
    if (!silent) busy(false);
  }
  return added;
}

async function insertBlankPage() {
  const ref = state.current || state.pages[state.pages.length - 1];
  let size = [595, 842];
  if (ref) { const v = ref.proxy.view; size = [v[2] - v[0], v[3] - v[1]]; }
  const doc = await PDFLib.PDFDocument.create();
  doc.addPage(size);
  const bytes = await doc.save();
  const key = `doc${state.nextDoc++}`;
  state.docs.set(key, { bytes, pdf: await loadPdfjsDocument(bytes), name: 'Página em branco' });
  const [entry] = await addDocPages(key, ref ? state.pages.indexOf(ref) + 1 : state.pages.length);
  setCurrent(entry);
  entry.el.scrollIntoView({ block: 'start' });
  setDirty(true);
  return entry;
}

// ---------- fabric: eventos, histórico ----------

function snapshot(entry) {
  if (!entry.fabric) return entry.lastJson;
  return JSON.stringify(dehydrate(entry.fabric.toObject()));
}

function pushHistory(entry) {
  if (state.suspend || !entry.fabric) return;
  const now = snapshot(entry);
  if (now === entry.lastJson) return;
  state.history.push({ id: entry.id, json: entry.lastJson });
  if (state.history.length > 300) state.history.shift();
  state.redo = [];
  entry.lastJson = now;
  setDirty(true);
  updateButtons();
  if (isTextTool()) renderHits(entry);
  features?.refreshComments();
}

function normalizeObject(obj) {
  if (obj.kind === 'cover') obj.set({ selectable: false, evented: false });
  if (obj.kind === 'highlight') obj.set({ globalCompositeOperation: 'multiply' });
}

async function restore(entry, json) {
  entry.lastJson = json; // antes de esperar: desfazer rápido não lê estado velho
  if (entry.materializing) await entry.materializing;
  if (entry.fabric) {
    await loadInto(entry, json);
    // o cabeçalho/rodapé guardado no passo antigo pode estar com a numeração velha
    if (state.hf) { features?.refreshHeaderFooter(entry); entry.lastJson = snapshot(entry); }
  }
  if (state.tool === 'edittext' && entry.fabric) renderHits(entry);
  features?.refreshComments();
}

// Desfazer/refazer em fila: segurar Ctrl+Z não embaralha os passos
let historyQueue = Promise.resolve();
function queueHistory(fn) {
  historyQueue = historyQueue.then(fn, fn);
  return historyQueue;
}

function undo() {
  return queueHistory(async () => {
    const step = state.history.pop();
    if (!step) return;
    const entry = state.pages.find((p) => p.id === step.id);
    if (entry) {
      state.redo.push({ id: entry.id, json: entry.lastJson });
      if (!entry.visible) entry.el.scrollIntoView({ block: 'center' });
      await restore(entry, step.json);
    }
    setDirty(true);
    updateButtons();
  });
}

function redo() {
  return queueHistory(async () => {
    const step = state.redo.pop();
    if (!step) return;
    const entry = state.pages.find((p) => p.id === step.id);
    if (entry) {
      state.history.push({ id: entry.id, json: entry.lastJson });
      if (!entry.visible) entry.el.scrollIntoView({ block: 'center' });
      await restore(entry, step.json);
    }
    setDirty(true);
    updateButtons();
  });
}

function addObjects(entry, objects, { select = true } = {}) {
  state.suspend++;
  entry.fabric.add(...objects);
  state.suspend--;
  if (select) entry.fabric.setActiveObject(objects[objects.length - 1]);
  entry.fabric.requestRenderAll();
  pushHistory(entry);
}

function removeObjects(entry, objects, { keepLinked = false } = {}) {
  const canvas = entry.fabric;
  state.suspend++;
  for (const obj of objects) {
    canvas.remove(obj);
    if (obj.link && !keepLinked) canvas.getObjects().filter((o) => o.uid === obj.link).forEach((o) => canvas.remove(o));
  }
  canvas.discardActiveObject();
  canvas.requestRenderAll();
  state.suspend--;
  pushHistory(entry);
}

let drag = null;

function wireCanvas(entry) {
  const canvas = entry.fabric;
  const changed = () => pushHistory(entry);
  canvas.on('object:added', changed);
  canvas.on('object:removed', changed);
  canvas.on('object:modified', changed);
  canvas.on('before:path:created', ({ path }) => {
    path.set({ kind: 'ink', uid: newUid(), opacity: state.stroke.opacity });
  });
  canvas.on('path:created', changed);
  canvas.on('text:editing:exited', ({ target }) => {
    // apagar todo o texto de uma frase editada apaga a frase (a cobertura fica)
    if (!target.text.trim()) removeObjects(entry, [target], { keepLinked: target.kind === 'edited' });
    else changed();
  });
  canvas.on('selection:created', () => onSelection(entry));
  canvas.on('selection:updated', () => onSelection(entry));
  canvas.on('selection:cleared', () => onSelection(entry));

  canvas.on('mouse:down', (opt) => {
    const p = opt.scenePoint;
    if (CLICK_TOOLS.includes(state.tool) && !opt.target) {
      const tool = state.tool;
      setTool('select');
      if (tool === 'text') addText(entry, p);
      else if (tool === 'note') features.addNote(entry, p);
      else if (tool === 'stamp') features.placeStamp(entry, p);
    } else if (DRAG_TOOLS.includes(state.tool)) {
      const live = ['line', 'arrow'].includes(state.tool)
        ? new fabric.Line([p.x, p.y, p.x, p.y], { stroke: state.stroke.color, strokeWidth: state.stroke.width, selectable: false, evented: false })
        : new fabric.Rect({ left: p.x, top: p.y, width: 1, height: 1, fill: 'rgba(31,94,255,.08)', stroke: '#1f5eff', strokeWidth: 1 / state.zoom, strokeDashArray: [4 / state.zoom, 3 / state.zoom], selectable: false, evented: false });
      state.suspend++;
      canvas.add(live);
      state.suspend--;
      drag = { entry, tool: state.tool, x0: p.x, y0: p.y, x1: p.x, y1: p.y, preview: live };
    }
  });
  canvas.on('mouse:move', (opt) => {
    if (!drag || drag.entry !== entry) return;
    const p = opt.scenePoint;
    drag.x1 = p.x;
    drag.y1 = p.y;
    if (drag.preview instanceof fabric.Line) drag.preview.set({ x2: p.x, y2: p.y });
    else drag.preview.set({ left: Math.min(drag.x0, p.x), top: Math.min(drag.y0, p.y), width: Math.abs(p.x - drag.x0), height: Math.abs(p.y - drag.y0) });
    canvas.requestRenderAll();
  });
  canvas.on('mouse:up', () => {
    if (!drag || drag.entry !== entry) return;
    const d = drag;
    drag = null;
    state.suspend++;
    canvas.remove(d.preview);
    state.suspend--;
    if (d.tool.startsWith('field-')) {
      const type = d.tool.slice(6);
      const size = { text: [180, 22], check: [14, 14], list: [160, 22] }[type];
      let width = Math.abs(d.x1 - d.x0);
      let height = Math.abs(d.y1 - d.y0);
      if (width < 6 && height < 6) [width, height] = size;
      features.createField(entry, { left: Math.min(d.x0, d.x1), top: Math.min(d.y0, d.y1), width, height }, type);
      return;
    }
    const obj = makeShape(d.tool, d.x0, d.y0, d.x1, d.y1);
    if (obj) addObjects(entry, [obj]);
  });
}

// Cria a forma final a partir do arraste (x0,y0) -> (x1,y1)
function makeShape(tool, x0, y0, x1, y1) {
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  let width = Math.abs(x1 - x0);
  let height = Math.abs(y1 - y0);
  const tiny = width < 4 && height < 4;
  const defaults = { whiteout: [140, 24], highlight: [140, 16], rect: [140, 80], redact: [140, 22], ellipse: [120, 80], underline: [140, 14], strike: [140, 14] };
  if (tiny && defaults[tool]) [width, height] = defaults[tool];
  const base = { uid: newUid(), strokeUniform: true, opacity: 1 };
  const s = state.stroke;
  switch (tool) {
    case 'whiteout': return new fabric.Rect({ ...base, left, top, width, height, kind: 'whiteout', fill: '#ffffff', strokeWidth: 0 });
    case 'redact': return new fabric.Rect({ ...base, left, top, width, height, kind: 'redact', fill: '#000000', strokeWidth: 0 });
    case 'highlight': return new fabric.Rect({ ...base, left, top, width, height, kind: 'highlight', fill: 'rgba(255, 230, 0, 0.45)', strokeWidth: 0, globalCompositeOperation: 'multiply' });
    case 'rect': return new fabric.Rect({ ...base, left, top, width, height, kind: 'rect', fill: 'transparent', stroke: s.color, strokeWidth: s.width, opacity: s.opacity });
    case 'ellipse': return new fabric.Ellipse({ ...base, left, top, rx: width / 2, ry: height / 2, kind: 'ellipse', fill: 'transparent', stroke: s.color, strokeWidth: s.width, opacity: s.opacity });
    case 'underline':
    case 'strike': {
      const y = tool === 'underline' ? top + height : top + height / 2;
      const color = tool === 'underline' ? '#1f5eff' : '#d32f2f';
      return new fabric.Line([left, y, left + width, y], { ...base, kind: tool, stroke: color, strokeWidth: Math.max(1, Math.min(3, height * 0.12)) });
    }
    case 'line':
    case 'arrow': {
      if (tiny) { x1 = x0 + 120; y1 = y0; }
      if (tool === 'line') return new fabric.Line([x0, y0, x1, y1], { ...base, kind: 'line', stroke: s.color, strokeWidth: s.width, opacity: s.opacity, strokeLineCap: 'round' });
      const ang = Math.atan2(y1 - y0, x1 - x0);
      const head = Math.max(10, s.width * 4);
      const hx1 = x1 - head * Math.cos(ang - Math.PI / 7);
      const hy1 = y1 - head * Math.sin(ang - Math.PI / 7);
      const hx2 = x1 - head * Math.cos(ang + Math.PI / 7);
      const hy2 = y1 - head * Math.sin(ang + Math.PI / 7);
      return new fabric.Path(`M ${x0} ${y0} L ${x1} ${y1} M ${hx1} ${hy1} L ${x1} ${y1} L ${hx2} ${hy2}`, {
        ...base, kind: 'arrow', fill: '', stroke: s.color, strokeWidth: s.width, opacity: s.opacity, strokeLineCap: 'round', strokeLineJoin: 'round',
      });
    }
    default: return null;
  }
}

function addText(entry, point, value = t('Texto')) {
  const s = state.textStyle;
  const text = new fabric.IText(value, {
    left: point.x,
    top: point.y - s.fontSize * 0.6,
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    fill: s.fill,
    fontWeight: s.bold ? 'bold' : 'normal',
    fontStyle: s.italic ? 'italic' : 'normal',
    underline: s.underline,
    textAlign: s.align,
    kind: 'text',
    uid: newUid(),
  });
  addObjects(entry, [text]);
  text.enterEditing();
  text.selectAll();
  entry.fabric.requestRenderAll();
  return text;
}

function visibleCenter(entry) {
  const pr = entry.el.getBoundingClientRect();
  const vr = viewerEl.getBoundingClientRect();
  const top = Math.max(pr.top, vr.top);
  const bottom = Math.min(pr.bottom, vr.bottom);
  const y = bottom > top ? (top + bottom) / 2 - pr.top : pr.height / 2;
  return new fabric.Point(pr.width / 2 / state.zoom, y / state.zoom);
}

async function addImage(entry, dataUrl, kind = 'image', maxRatio = 0.4, at = null) {
  const img = await fabric.FabricImage.fromURL(dataUrl);
  const vp = entry.viewport();
  const scale = Math.min(1, (vp.width * maxRatio) / img.width, (vp.height * maxRatio) / img.height);
  const c = at || visibleCenter(entry);
  img.set({ scaleX: scale, scaleY: scale, kind, uid: newUid() });
  img.set({ left: c.x - (img.width * scale) / 2, top: c.y - (img.height * scale) / 2 });
  addObjects(entry, [img]);
  return img;
}

async function addImageFile(entry, file, kind = 'image', maxRatio = 0.4, at = null) {
  const { dataUrl } = await toEmbeddableImage(file.data, file.mime);
  return addImage(entry, dataUrl, kind, maxRatio, at);
}

// ---------- editar texto existente ----------

const isTextTool = () => state.tool === 'edittext' || state.tool === 'editpara';

function renderHits(entry) {
  if (!isTextTool()) { entry.hitLayer.replaceChildren(); return; }
  if (state.tool === 'editpara') renderTextHits(entry, state.zoom, onPickParagraph, true);
  else renderTextHits(entry, state.zoom, onPickRun);
}

async function ensureRuns(entry) {
  if (!entry.runs) {
    try { entry.runs = await loadTextRuns(entry); } catch (err) { console.error(err); entry.runs = []; }
    entry.paras = groupParagraphs(entry, entry.runs);
  }
  if (isTextTool()) renderHits(entry);
  return entry.runs;
}

function onPickParagraph(entry, para) {
  return onPickRun(entry, para, createParagraphEdit(entry, para));
}

function onPickRun(entry, run, made = null) {
  const { cover, text } = made || createTextEdit(entry, run);
  state.suspend++;
  entry.fabric.add(cover, text);
  state.suspend--;
  setTool('select');
  entry.fabric.setActiveObject(text);
  text.enterEditing();
  text.setSelectionStart(text.text.length);
  text.setSelectionEnd(text.text.length);
  entry.fabric.requestRenderAll();
  pushHistory(entry);
  return text;
}

// ---------- ferramentas e propriedades ----------

function applyToolTo(entry) {
  const canvas = entry.fabric;
  if (!canvas) return;
  const t = state.tool;
  canvas.isDrawingMode = t === 'pen';
  if (t === 'pen') {
    canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
    canvas.freeDrawingBrush.color = state.stroke.color;
    canvas.freeDrawingBrush.width = state.stroke.width;
  }
  canvas.selection = t === 'select';
  canvas.skipTargetFind = t !== 'select';
  canvas.defaultCursor = t === 'select' ? 'default' : 'crosshair';
  if (t !== 'select') canvas.discardActiveObject();
  canvas.requestRenderAll();
}

const HINTS = {
  select: 'Clique num item para mover, redimensionar ou excluir. Clique duas vezes num texto para editar.',
  edittext: 'Passe o mouse sobre o PDF e clique na frase que quer alterar.',
  editpara: 'Clique num parágrafo: ao editar, o texto se reorganiza nas linhas.',
  text: 'Clique na página onde quer escrever.',
  whiteout: 'Arraste sobre a área: o que estiver embaixo é apagado do PDF ao salvar.',
  redact: 'Arraste para tarjar: texto e imagens embaixo são removidos de verdade ao salvar.',
  highlight: 'Arraste sobre o trecho que quer destacar.',
  underline: 'Arraste sobre o trecho que quer sublinhar.',
  strike: 'Arraste sobre o trecho que quer riscar.',
  rect: 'Arraste para desenhar o retângulo.',
  ellipse: 'Arraste para desenhar a elipse.',
  line: 'Arraste para desenhar a linha.',
  arrow: 'Arraste do início para a ponta da seta.',
  pen: 'Desenhe com o mouse. Esc para voltar.',
  note: 'Clique onde quer deixar o comentário.',
  'field-text': 'Arraste para desenhar o campo de texto.',
  'field-check': 'Clique ou arraste onde vai a caixa de marcar.',
  'field-list': 'Arraste para desenhar a lista de opções.',
  stamp: 'Clique na página onde quer colocar o carimbo.',
};

function setTool(tool) {
  state.tool = tool;
  document.body.className = document.body.className.replace(/\btool-\S+/g, '').trim();
  document.body.classList.add(`tool-${tool}`);
  for (const b of document.querySelectorAll('.ribbon .tool[data-tool]')) b.classList.toggle('active', b.dataset.tool === tool);
  for (const entry of state.pages) {
    applyToolTo(entry);
    if (tool === 'edittext') ensureRuns(entry);
    else entry.hitLayer.replaceChildren();
  }
  if (tool !== 'stamp') { state.pendingStamp = null; $('#stamp-select').value = ''; }
  $('#hint').textContent = t(HINTS[tool] || '');
}

function activeObjects() {
  const entry = state.pages.find((p) => p.fabric?.getActiveObject());
  if (!entry) return { entry: null, objects: [] };
  return { entry, objects: entry.fabric.getActiveObjects() };
}

const hex = (c) => { try { return '#' + new fabric.Color(c).toHex().slice(0, 6); } catch { return '#000000'; } };
const isShape = (o) => ['rect', 'ellipse', 'line', 'arrow', 'ink'].includes(o.kind);

function onSelection(entry) {
  const { objects } = activeObjects();
  for (const id of ['#prop-delete', '#prop-front', '#prop-back', '#prop-duplicate']) $(id).disabled = !objects.length;
  const text = objects.find((o) => o instanceof fabric.IText);
  if (text) {
    $('#prop-font').value = text.fontFamily;
    $('#prop-size').value = Math.round(text.fontSize * (text.scaleY || 1));
    $('#prop-color').value = hex(text.fill);
    $('#prop-bold').classList.toggle('on', text.fontWeight === 'bold');
    $('#prop-italic').classList.toggle('on', text.fontStyle === 'italic');
    $('#prop-underline').classList.toggle('on', !!text.underline);
    $('#prop-align').value = text.textAlign || 'left';
  }
  const shape = objects.find(isShape);
  if (shape) {
    $('#prop-stroke').value = Math.round(shape.strokeWidth);
    $('#prop-stroke-color').value = hex(shape.stroke);
  }
  if (objects[0]) $('#prop-opacity').value = Math.round((objects[0].opacity ?? 1) * 100);
  if (entry) setCurrent(entry);
}

function applyTextProp(apply) {
  const { entry, objects } = activeObjects();
  const texts = objects.filter((o) => o instanceof fabric.IText);
  for (const t of texts) { apply(t); t.initDimensions?.(); t.setCoords(); }
  if (entry && texts.length) { entry.fabric.requestRenderAll(); pushHistory(entry); }
}

function applyShapeProp(apply) {
  const { entry, objects } = activeObjects();
  const shapes = objects.filter(isShape);
  for (const s of shapes) apply(s);
  if (entry && shapes.length) { entry.fabric.requestRenderAll(); pushHistory(entry); }
  if (state.tool === 'pen') for (const p of state.pages) applyToolTo(p);
}

function setupPropbar() {
  const select = $('#prop-font');
  for (const { family, script } of state.fonts) {
    if (script) continue;
    const opt = new Option(family, family);
    opt.style.fontFamily = family;
    select.append(opt);
  }
  select.value = state.textStyle.fontFamily;
  select.addEventListener('change', () => {
    state.textStyle.fontFamily = select.value;
    applyTextProp((t) => t.set('fontFamily', select.value));
  });
  $('#prop-size').addEventListener('change', (e) => {
    const v = Math.max(4, Math.min(200, Number(e.target.value) || 14));
    state.textStyle.fontSize = v;
    applyTextProp((t) => t.set({ fontSize: v / (t.scaleY || 1) }));
  });
  $('#prop-color').addEventListener('input', (e) => {
    state.textStyle.fill = e.target.value;
    applyTextProp((t) => t.set('fill', e.target.value));
  });
  const toggle = (id, key, apply) => $(id).addEventListener('click', (e) => {
    const on = !e.currentTarget.classList.contains('on');
    e.currentTarget.classList.toggle('on', on);
    state.textStyle[key] = on;
    applyTextProp((t) => apply(t, on));
  });
  toggle('#prop-bold', 'bold', (t, on) => t.set('fontWeight', on ? 'bold' : 'normal'));
  toggle('#prop-italic', 'italic', (t, on) => t.set('fontStyle', on ? 'italic' : 'normal'));
  toggle('#prop-underline', 'underline', (t, on) => t.set('underline', on));
  $('#prop-align').addEventListener('change', (e) => {
    state.textStyle.align = e.target.value;
    applyTextProp((t) => t.set('textAlign', e.target.value));
  });
  $('#prop-stroke').addEventListener('change', (e) => {
    const v = Math.max(1, Math.min(40, Number(e.target.value) || 2));
    state.stroke.width = v;
    applyShapeProp((s) => s.set('strokeWidth', v));
  });
  $('#prop-stroke-color').addEventListener('input', (e) => {
    state.stroke.color = e.target.value;
    applyShapeProp((s) => s.set('stroke', e.target.value));
  });
  $('#prop-opacity').addEventListener('change', (e) => {
    const v = Number(e.target.value) / 100;
    state.stroke.opacity = v;
    const { entry, objects } = activeObjects();
    for (const o of objects) o.set('opacity', v);
    if (entry && objects.length) { entry.fabric.requestRenderAll(); pushHistory(entry); }
  });
  $('#prop-delete').addEventListener('click', deleteSelection);
  $('#prop-duplicate').addEventListener('click', duplicateSelection);
  $('#prop-front').addEventListener('click', () => reorderSelection(true));
  $('#prop-back').addEventListener('click', () => reorderSelection(false));
}

function deleteSelection() {
  const { entry, objects } = activeObjects();
  if (!entry || !objects.length || objects.some((o) => o.isEditing)) return;
  removeObjects(entry, objects);
}

async function duplicateSelection() {
  const { entry, objects } = activeObjects();
  if (!entry || !objects.length) return;
  entry.fabric.discardActiveObject();
  const clones = [];
  for (const o of objects) {
    if (o.kind === 'cover') continue;
    const c = await o.clone();
    c.set({ left: o.left + 12, top: o.top + 12, uid: newUid(), link: undefined, runKey: undefined });
    clones.push(c);
  }
  if (clones.length) addObjects(entry, clones);
}

function reorderSelection(front) {
  const { entry, objects } = activeObjects();
  if (!entry) return;
  for (const o of objects) front ? entry.fabric.bringObjectToFront(o) : entry.fabric.sendObjectToBack(o);
  // a cobertura de texto editado fica sempre atrás do texto novo
  for (const o of entry.fabric.getObjects().filter((x) => x.kind === 'cover')) entry.fabric.sendObjectToBack(o);
  entry.fabric.requestRenderAll();
  pushHistory(entry);
}

// ---------- zoom ----------

function setZoom(z) {
  const zoom = Math.max(ZOOMS[0], Math.min(ZOOMS[ZOOMS.length - 1], z));
  if (zoom === state.zoom) return;
  const ratio = viewerEl.scrollHeight ? (viewerEl.scrollTop + viewerEl.clientHeight / 2) / viewerEl.scrollHeight : 0;
  state.zoom = zoom;
  $('#zoom-label').textContent = `${Math.round(zoom * 100)}%`;
  for (const p of state.pages) sizePage(p);
  viewerEl.scrollTop = ratio * viewerEl.scrollHeight - viewerEl.clientHeight / 2;
}

function stepZoom(dir) {
  const i = ZOOMS.findIndex((z) => z >= state.zoom - 1e-6);
  const next = dir > 0 ? ZOOMS[Math.min(ZOOMS.length - 1, (ZOOMS[i] > state.zoom + 1e-6 ? i : i + 1))] : ZOOMS[Math.max(0, i - 1)];
  setZoom(next);
}

function fitWidth() {
  if (!state.pages.length) return;
  const w = Math.max(...state.pages.slice(0, 5).map((p) => p.viewport().width));
  const avail = viewerEl.clientWidth - 70;
  setZoom(Math.min(1.5, Math.max(0.33, Math.round((avail / w) * 100) / 100)));
}

// ---------- salvar ----------

function finishEditing() {
  for (const p of state.pages) {
    if (!p.fabric) continue;
    const active = p.fabric.getActiveObject();
    if (active?.isEditing) active.exitEditing();
    p.fabric.discardActiveObject();
    p.fabric.requestRenderAll();
  }
}

// Gera os bytes do PDF final. encrypt=false para exportações (Word, imagens, dividir...)
async function buildFinal({ encrypt = true } = {}) {
  finishEditing();
  // páginas longe da tela com cabeçalho/rodapé pendente
  for (const e of state.pages) if (e.hfStale) await materialize(e);
  const sources = new Map();
  for (const job of await collectRedactions(state)) {
    busy('Apagando o conteúdo coberto…');
    const r = await api.engine('redact', { bytes: state.docs.get(job.docKey).bytes, pages: job.pages });
    sources.set(job.sourceKey, r.bytes);
  }
  busy('Montando o PDF…');
  let bytes = await buildPdf(state, (family, variant) => api.getFont(family, variant), sources);
  // sempre passa pelo motor: remove de verdade o conteúdo de páginas excluídas, compacta e aplica a senha
  const p = state.protection;
  busy(encrypt && p ? 'Aplicando a senha…' : 'Finalizando…');
  const encryptOpt = encrypt && p ? { user: p.user, owner: p.owner, permissions: p.permissions ?? permissionsFrom(p) } : null;
  bytes = (await api.engine('finalize', { bytes, encrypt: encryptOpt, sanitize: state.sanitize })).bytes;
  trimMemory();
  return bytes;
}

function suggestedPath(suffix = ' (editado)', ext = 'pdf') {
  const dir = (state.savedPath || state.file?.path || '').replace(/[^\\/]+$/, '');
  return `${dir}${baseName()}${suffix}.${ext}`;
}

function save(saveAs = false, selftestName = null) {
  if (!hasDoc()) return null;
  return exclusive(() => saveNow(saveAs, selftestName));
}

async function saveNow(saveAs, selftestName) {
  busy('Salvando…');
  try {
    const bytes = await buildFinal();
    state.lastSavedBytes = bytes;
    const result = await api.savePdf(bytes, { path: state.savedPath, saveAs, suggestedPath: state.savedPath || suggestedPath(), selftestName });
    if (!result) return null;
    state.savedPath = result.path;
    setDirty(false);
    toast(t('Salvo: {nome} ({tamanho})', { nome: result.name, tamanho: formatBytes(bytes.length) }), false, { label: 'Mostrar na pasta', run: () => api.showInFolder(result.path) });
    return result;
  } catch (err) {
    console.error(err);
    toast(t('Não consegui salvar: {erro}', { erro: err?.message || err }), true);
    return null;
  } finally {
    busy(false);
  }
}

// ---------- eventos ----------

function isTypingTarget(el) {
  if (!el) return false;
  if (el.closest?.('.form-layer, .modal, .searchbar')) return true;
  return ['INPUT', 'SELECT'].includes(el.tagName) || (el.tagName === 'TEXTAREA' && !el.hasAttribute('data-fabric'));
}

const anyTextEditing = () => state.pages.some((p) => p.fabric?.getActiveObject()?.isEditing);

function setupEvents() {
  const openDialog = async () => openFiles(await api.openFiles());
  $('#btn-open').addEventListener('click', openDialog);
  $('#btn-open-empty').addEventListener('click', openDialog);
  $('#btn-save').addEventListener('click', () => save(false));
  $('#btn-saveas').addEventListener('click', () => save(true));
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);
  $('#btn-zoom-in').addEventListener('click', () => stepZoom(1));
  $('#btn-zoom-out').addEventListener('click', () => stepZoom(-1));
  $('#zoom-label').addEventListener('click', fitWidth);

  for (const tab of document.querySelectorAll('#tabs .tab')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll('#tabs .tab')) t.classList.toggle('active', t === tab);
      for (const p of document.querySelectorAll('.ribbon .panel')) p.classList.toggle('active', p.dataset.panel === tab.dataset.tab);
    });
  }
  for (const b of document.querySelectorAll('.ribbon .tool[data-tool]')) {
    b.addEventListener('click', () => {
      if (!hasDoc()) { toast('Abra um PDF primeiro.'); return; }
      setTool(b.dataset.tool);
    });
  }
  for (const b of document.querySelectorAll('.ribbon .tool[data-action]')) {
    b.addEventListener('click', () => features.run(b.dataset.action));
  }
  for (const b of document.querySelectorAll('.side-tab')) {
    b.addEventListener('click', () => {
      for (const t of document.querySelectorAll('.side-tab')) t.classList.toggle('active', t === b);
      for (const p of document.querySelectorAll('.side-panel')) p.classList.toggle('active', p.dataset.sidePanel === b.dataset.side);
    });
  }
  $('#opt-sanitize').addEventListener('change', (e) => { state.sanitize = e.target.checked; if (hasDoc()) setDirty(true); });

  viewerEl.addEventListener('scroll', () => requestAnimationFrame(trackCurrentOnScroll), { passive: true });
  viewerEl.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    stepZoom(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
  window.addEventListener('resize', () => { for (const p of state.pages) p.fabric?.calcOffset(); });

  window.addEventListener('keydown', (e) => {
    if (isDialogOpen() || !$('#sig-modal').hidden) return;
    if (state.working || !$('#busy').hidden) { if (e.ctrlKey || e.metaKey || e.key === 'Delete' || e.key === 'Backspace') e.preventDefault(); return; }
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (ctrl && key === 's') { e.preventDefault(); save(e.shiftKey); return; }
    if (ctrl && key === 'o') { e.preventDefault(); $('#btn-open').click(); return; }
    if (ctrl && key === 'p') { e.preventDefault(); if (hasDoc()) features.run('print'); return; }
    if (ctrl && key === 'f') { e.preventDefault(); if (hasDoc()) features.openSearch(); return; }
    if (isTypingTarget(e.target) || anyTextEditing()) return;
    if (ctrl && key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (ctrl && key === 'd') { e.preventDefault(); duplicateSelection(); }
    else if (ctrl && (key === '=' || key === '+')) { e.preventDefault(); stepZoom(1); }
    else if (ctrl && key === '-') { e.preventDefault(); stepZoom(-1); }
    else if (ctrl && key === '0') { e.preventDefault(); fitWidth(); }
    else if (key === 'delete' || key === 'backspace') { e.preventDefault(); deleteSelection(); }
    else if (key === 'escape') { setTool('select'); features.closeSearch(); }
    else if (key === 'pagedown' || key === 'pageup') {
      const i = state.pages.indexOf(state.current);
      const next = state.pages[Math.max(0, Math.min(state.pages.length - 1, i + (key === 'pagedown' ? 1 : -1)))];
      if (next) { e.preventDefault(); next.el.scrollIntoView({ block: 'start' }); setCurrent(next); }
    } else if (key.startsWith('arrow')) {
      const { entry, objects } = activeObjects();
      if (!entry || !objects.length) return;
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1) / state.zoom;
      const target = entry.fabric.getActiveObject();
      target.set({
        left: target.left + (key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0),
        top: target.top + (key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0),
      });
      target.setCoords();
      entry.fabric.requestRenderAll();
      pushHistory(entry);
    }
  });

  // Arrastar arquivos para a janela: abre (ou insere, se já houver documento)
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer?.types?.includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('drop-target'); } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('drop-target'); } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('drop-target');
    const accepted = [...e.dataTransfer.files].filter((f) => /\.pdf$/i.test(f.name) || IMAGE_MIME.test(f.type));
    if (!accepted.length) { toast('Solte arquivos PDF ou imagens.', true); return; }
    const files = await Promise.all(accepted.map(async (f) => ({ name: f.name, path: api.pathForFile?.(f) || null, mime: f.type || 'application/pdf', data: new Uint8Array(await f.arrayBuffer()) })));
    if (!hasDoc()) { openFiles(files); return; }
    const choice = await choiceDialog('Arquivos soltos', files.length > 1 ? 'Inserir esses arquivos no final do documento atual?' : 'Inserir esse arquivo no final do documento atual?', 'Inserir no final', 'Abrir como novo');
    if (choice === 'ok') insertDocs(files);
    else if (choice === 'alt') openFiles(files);
  });

  api.onFileOpened((file) => openFiles([file]));
  api.onEngineProgress((info) => { if (!$('#busy').hidden && info?.message) $('#busy-text').textContent = t(info.message, info.vars); });
}

// ---------- início ----------

const ctx = {
  state, api, fabric, PDFLib, t, toast, busy, setDirty, updateButtons, formatBytes, baseName, hasDoc,
  openFiles, openPdf, insertDocs, insertBlankPage, movePage, rotatePage, deletePages, duplicatePages, replaceDocBytes, targetPages,
  materialize, trimMemory, exclusive, addText, addImage, addImageFile, addObjects, removeObjects, makeShape, toEmbeddableImage, imagesToPdf,
  snapshot, ensureRuns, onPickRun, onPickParagraph, pushHistory, undo, redo, save, buildFinal, suggestedPath, setZoom, setTool, setCurrent, fitWidth, renderPage, finishEditing,
};
let features = null;

async function start() {
  state.fonts = await api.fontFamilies();
  translateDom();
  api.setLang(getLang());
  const langSelect = $('#lang-select');
  langSelect.value = getLang();
  langSelect.addEventListener('change', () => {
    setLang(langSelect.value);
    // partes geradas pelo código são refeitas no idioma novo
    setTool(state.tool);
    updateButtons();
    layoutPages();
    for (const p of state.pages) for (const b of p.thumb?.querySelectorAll('button[data-title]') || []) b.title = t(b.dataset.title);
    features.refreshComments();
    features.loadOutline();
    features.loadRecent();
    toast(getLang() === 'en' ? 'Language changed to English.' : 'Idioma alterado para português.');
  });
  features = setupFeatures(ctx);
  setupEvents();
  setupPropbar();
  setTool('select');
  updateButtons();
  updateTitle();

  const test = await api.testConfig();
  setTimeout(() => $('#splash').classList.add('hide'), test ? 0 : 1300);
  setTimeout(() => $('#splash').remove(), test ? 50 : 1800);
  if (test) {
    const { runSelftest } = await import('./selftest.js');
    await runSelftest({ ...ctx, features }, test);
    return;
  }
  features.loadRecent();
  const initial = await api.initialFile();
  if (initial) await openFiles([initial]);
}

start();
