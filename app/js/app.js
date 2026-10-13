import { pdfjs, fabric, loadPdfjsDocument, newUid } from './libs.js';
import { buildPdf } from './save.js';
import { readFormFields, renderFormLayer } from './forms.js';
import { loadTextRuns, createTextEdit, renderTextHits } from './textedit.js';

const api = window.api;
const $ = (sel) => document.querySelector(sel);
const viewerEl = $('#viewer');
const pagesEl = $('#pages');
const thumbsEl = $('#thumbs');

const ZOOMS = [0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const DRAG_TOOLS = ['whiteout', 'highlight', 'rect'];

const state = {
  docs: new Map(),     // chave -> { bytes, pdf (pdf.js), name }
  pages: [],           // páginas na ordem final
  formFields: [],
  file: null,          // { path, name } do arquivo aberto
  savedPath: null,
  zoom: 1,
  tool: 'select',
  dirty: false,
  current: null,
  history: [],
  redo: [],
  suspend: 0,
  nextDoc: 1,
  nextPage: 1,
  textStyle: { fontFamily: 'Arial', fontSize: 14, fill: '#000000', bold: false, italic: false },
  stroke: { width: 2, color: '#d32f2f' },
  lastSavedBytes: null,
};

// ---------- utilidades de interface ----------

let toastTimer = null;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 2600);
}

function busy(message) {
  $('#busy').hidden = !message;
  if (message) $('#busy-text').textContent = message;
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

function hasDoc() { return state.pages.length > 0; }

function updateButtons() {
  const open = hasDoc();
  $('#btn-save').disabled = !open;
  $('#btn-saveas').disabled = !open;
  $('#btn-insert').disabled = !open;
  $('#btn-undo').disabled = !state.history.length;
  $('#btn-redo').disabled = !state.redo.length;
  $('#empty').hidden = open;
}

// ---------- páginas ----------

function makeEntry(docKey, index, proxy) {
  return {
    id: state.nextPage++,
    docKey,
    index,
    proxy,
    baseRot: proxy.rotate || 0,
    extraRot: 0,
    el: null,
    pdfCanvas: null,
    fabric: null,
    hitLayer: null,
    formLayer: null,
    runs: null,
    renderTask: null,
    renderedKey: null,
    visible: false,
    lastJson: null,
    thumb: null,
    rotation() { return (this.baseRot + this.extraRot) % 360; },
    viewport(scale = 1) { return this.proxy.getViewport({ scale, rotation: this.rotation() }); },
  };
}

const observer = new IntersectionObserver((records) => {
  for (const r of records) {
    const entry = state.pages.find((e) => e.el === r.target);
    if (!entry) continue;
    entry.visible = r.isIntersecting;
    if (r.isIntersecting) renderPage(entry);
  }
}, { root: viewerEl, rootMargin: '800px 0px' });

function buildPageDom(entry) {
  const el = document.createElement('div');
  el.className = 'page';
  const pdfCanvas = document.createElement('canvas');
  pdfCanvas.className = 'pdf';
  const fabricEl = document.createElement('canvas');
  const hitLayer = document.createElement('div');
  hitLayer.className = 'text-hits';
  const formLayer = document.createElement('div');
  formLayer.className = 'form-layer';
  const label = document.createElement('div');
  label.className = 'page-label';
  el.append(pdfCanvas, fabricEl, hitLayer, formLayer, label);
  pagesEl.append(el);
  Object.assign(entry, { el, pdfCanvas, hitLayer, formLayer, label });

  const vp = entry.viewport();
  const canvas = new fabric.Canvas(fabricEl, {
    width: vp.width * state.zoom,
    height: vp.height * state.zoom,
    preserveObjectStacking: true,
    selection: true,
    stopContextMenu: true,
    targetFindTolerance: 4,
  });
  entry.fabric = canvas;
  wireCanvas(entry);
  entry.lastJson = snapshot(entry);
  sizePage(entry);
  applyToolTo(entry);
  observer.observe(el);
  el.addEventListener('mousedown', () => setCurrent(entry), true);
}

function sizePage(entry) {
  const vp = entry.viewport();
  const w = vp.width * state.zoom;
  const h = vp.height * state.zoom;
  entry.el.style.width = `${w}px`;
  entry.el.style.height = `${h}px`;
  entry.pdfCanvas.style.width = `${w}px`;
  entry.pdfCanvas.style.height = `${h}px`;
  entry.fabric.setDimensions({ width: w, height: h });
  entry.fabric.setZoom(state.zoom);
  entry.fabric.calcOffset();
  entry.renderedKey = null;
  renderFormLayer(entry, state.formFields, state.zoom, onFormChange);
  if (state.tool === 'edittext') renderTextHits(entry, state.zoom, onPickRun);
  else entry.hitLayer.replaceChildren();
  if (entry.visible) renderPage(entry);
}

async function renderPage(entry) {
  const dpr = window.devicePixelRatio || 1;
  const key = `${state.zoom}|${entry.rotation()}|${dpr}`;
  if (entry.renderedKey === key) return;
  entry.renderedKey = key;
  if (entry.renderTask) entry.renderTask.cancel();
  const vp = entry.viewport(state.zoom * dpr);
  // Renderiza num canvas fora da tela e só troca no fim, para não piscar durante o zoom
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
    entry.label.textContent = `Página ${i + 1}`;
    if (!entry.thumb) buildThumb(entry);
    thumbsEl.append(entry.thumb);
    entry.thumb.querySelector('.num').textContent = String(i + 1);
  });
  for (const entry of state.pages) entry.fabric.calcOffset();
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
    b.title = title;
    if (cls) b.className = cls;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  };
  actions.append(
    mk('⟲', 'Girar para a esquerda', '', () => rotatePage(entry, -1)),
    mk('⟳', 'Girar para a direita', '', () => rotatePage(entry, 1)),
    mk('✕', 'Excluir página', 'del', () => deletePage(entry)),
  );
  li.append(canvas, num, actions);
  li.addEventListener('click', () => { setCurrent(entry); entry.el.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
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
    const target = without.indexOf(entry) + (after ? 1 : 0);
    movePage(moving, target);
  });
  entry.thumb = li;
  entry.thumbCanvas = canvas;
  renderThumb(entry);
}

async function renderThumb(entry) {
  const base = entry.viewport();
  const scale = 140 / Math.max(base.width, base.height);
  const vp = entry.viewport(scale * (window.devicePixelRatio || 1));
  const canvas = entry.thumbCanvas;
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  canvas.style.width = `${base.width * scale}px`;
  canvas.style.height = `${base.height * scale}px`;
  try {
    await entry.proxy.render({ canvas, viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') console.error(err);
  }
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
  for (let i = 0; i < doc.pdf.numPages; i++) {
    entries.push(makeEntry(docKey, i, await doc.pdf.getPage(i + 1)));
  }
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

function rotatePage(entry, dir) {
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
  renderThumb(entry);
  if (state.tool === 'edittext') ensureRuns(entry);
  setDirty(true);
  updateButtons();
}

function deletePage(entry) {
  if (state.pages.length <= 1) { toast('O documento precisa ter pelo menos uma página.', true); return; }
  observer.unobserve(entry.el);
  entry.renderTask?.cancel();
  entry.fabric.dispose();
  entry.el.remove();
  entry.thumb.remove();
  state.pages = state.pages.filter((p) => p !== entry);
  state.history = state.history.filter((h) => h.id !== entry.id);
  state.redo = state.redo.filter((h) => h.id !== entry.id);
  if (state.current === entry) state.current = null;
  layoutPages();
  trackCurrentOnScroll();
  setDirty(true);
  toast('Página excluída.');
}

// ---------- abrir / inserir ----------

function resetDocument() {
  for (const p of state.pages) {
    observer.unobserve(p.el);
    p.renderTask?.cancel();
    p.fabric.dispose();
    p.el.remove();
    p.thumb?.remove();
  }
  for (const d of state.docs.values()) d.pdf.loadingTask.destroy();
  Object.assign(state, {
    docs: new Map(), pages: [], formFields: [], file: null, savedPath: null,
    current: null, history: [], redo: [], nextDoc: 1,
  });
}

async function openFile(file) {
  if (!file) return;
  if (state.dirty && !window.confirm('Há alterações não salvas. Abrir outro arquivo e descartá-las?')) return;
  busy('Abrindo…');
  try {
    const bytes = new Uint8Array(file.data);
    const pdf = await loadPdfjsDocument(bytes);
    let forms = { fields: [], hasXFA: false };
    try {
      forms = await readFormFields(bytes);
    } catch (err) {
      if (/encrypt/i.test(String(err?.message))) {
        pdf.loadingTask.destroy();
        toast('Este PDF é protegido (criptografado) e não pode ser editado.', true);
        return;
      }
      console.warn('Formulário não lido', err);
    }
    resetDocument();
    state.docs.set('main', { bytes, pdf, name: file.name });
    state.file = { path: file.path || null, name: file.name || 'documento.pdf' };
    state.formFields = forms.fields;
    await addDocPages('main');
    setCurrent(state.pages[0]);
    fitWidth();
    viewerEl.scrollTop = 0;
    setDirty(false);
    updateButtons();
    if (forms.fields.length) toast(`Este PDF tem ${forms.fields.length} campo(s) de formulário para preencher.`);
  } catch (err) {
    console.error(err);
    toast(err?.name === 'PasswordException' ? 'Este PDF pede senha; ainda não é suportado.' : `Não consegui abrir o PDF: ${err?.message || err}`, true);
  } finally {
    busy(false);
  }
}

async function insertDocs(files) {
  if (!files?.length) return [];
  busy('Inserindo páginas…');
  const added = [];
  try {
    for (const file of files) {
      const bytes = new Uint8Array(file.data);
      const key = `doc${state.nextDoc++}`;
      const pdf = await loadPdfjsDocument(bytes);
      state.docs.set(key, { bytes, pdf, name: file.name });
      added.push(...await addDocPages(key));
    }
    setDirty(true);
    if (added[0]) { setCurrent(added[0]); added[0].el.scrollIntoView({ block: 'start' }); }
    toast(`${added.length} página(s) inserida(s).`);
  } catch (err) {
    console.error(err);
    toast(`Não consegui inserir: ${err?.message || err}`, true);
  } finally {
    busy(false);
  }
  return added;
}

// ---------- fabric: eventos, histórico ----------

function snapshot(entry) {
  return JSON.stringify(entry.fabric.toObject());
}

function pushHistory(entry) {
  if (state.suspend) return;
  const now = snapshot(entry);
  if (now === entry.lastJson) return;
  state.history.push({ id: entry.id, json: entry.lastJson });
  if (state.history.length > 200) state.history.shift();
  state.redo = [];
  entry.lastJson = now;
  setDirty(true);
  updateButtons();
  if (state.tool === 'edittext') renderTextHits(entry, state.zoom, onPickRun);
}

function normalizeObject(obj) {
  if (obj.kind === 'cover') obj.set({ selectable: false, evented: false });
  if (obj.kind === 'highlight') obj.set({ globalCompositeOperation: 'multiply' });
}

async function restore(entry, json) {
  state.suspend++;
  try {
    await entry.fabric.loadFromJSON(json);
    entry.fabric.getObjects().forEach(normalizeObject);
    entry.fabric.requestRenderAll();
  } finally {
    state.suspend--;
  }
  entry.lastJson = json;
  if (state.tool === 'edittext') renderTextHits(entry, state.zoom, onPickRun);
}

async function undo() {
  const step = state.history.pop();
  if (!step) return;
  const entry = state.pages.find((p) => p.id === step.id);
  if (entry) {
    state.redo.push({ id: entry.id, json: entry.lastJson });
    await restore(entry, step.json);
  }
  setDirty(true);
  updateButtons();
}

async function redo() {
  const step = state.redo.pop();
  if (!step) return;
  const entry = state.pages.find((p) => p.id === step.id);
  if (entry) {
    state.history.push({ id: entry.id, json: entry.lastJson });
    await restore(entry, step.json);
  }
  setDirty(true);
  updateButtons();
}

function removeObjects(entry, objects) {
  const canvas = entry.fabric;
  state.suspend++;
  for (const obj of objects) {
    canvas.remove(obj);
    if (obj.link) canvas.getObjects().filter((o) => o.uid === obj.link).forEach((o) => canvas.remove(o));
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
  canvas.on('path:created', ({ path }) => { path.set({ kind: 'ink', uid: newUid() }); changed(); });
  canvas.on('text:editing:exited', ({ target }) => {
    if (!target.text.trim()) removeObjects(entry, [target]);
    else changed();
  });
  canvas.on('selection:created', () => onSelection(entry));
  canvas.on('selection:updated', () => onSelection(entry));
  canvas.on('selection:cleared', () => onSelection(entry));

  canvas.on('mouse:down', (opt) => {
    const p = opt.scenePoint;
    if (state.tool === 'text' && !opt.target) {
      addText(entry, p);
      setTool('select');
    } else if (DRAG_TOOLS.includes(state.tool)) {
      const rect = makeShape(state.tool, p.x, p.y, 1, 1);
      state.suspend++;
      canvas.add(rect);
      state.suspend--;
      drag = { entry, x0: p.x, y0: p.y, rect };
    }
  });
  canvas.on('mouse:move', (opt) => {
    if (!drag || drag.entry !== entry) return;
    const p = opt.scenePoint;
    drag.rect.set({
      left: Math.min(drag.x0, p.x),
      top: Math.min(drag.y0, p.y),
      width: Math.abs(p.x - drag.x0),
      height: Math.abs(p.y - drag.y0),
    });
    canvas.requestRenderAll();
  });
  canvas.on('mouse:up', () => {
    if (!drag || drag.entry !== entry) return;
    const { rect } = drag;
    drag = null;
    if (rect.width < 4 && rect.height < 4) {
      const size = { whiteout: [140, 24], highlight: [140, 16], rect: [140, 80] }[rect.kind] || [120, 40];
      rect.set({ width: size[0], height: size[1] });
    }
    rect.setCoords();
    canvas.setActiveObject(rect);
    canvas.requestRenderAll();
    pushHistory(entry);
  });
}

function makeShape(tool, left, top, width, height) {
  const base = { left, top, width, height, uid: newUid(), strokeUniform: true };
  if (tool === 'whiteout') return new fabric.Rect({ ...base, kind: 'whiteout', fill: '#ffffff', strokeWidth: 0 });
  if (tool === 'highlight') return new fabric.Rect({ ...base, kind: 'highlight', fill: 'rgba(255, 230, 0, 0.45)', strokeWidth: 0, globalCompositeOperation: 'multiply' });
  return new fabric.Rect({ ...base, kind: 'rect', fill: 'transparent', stroke: state.stroke.color, strokeWidth: state.stroke.width });
}

function addText(entry, point, value = 'Texto') {
  const s = state.textStyle;
  const text = new fabric.IText(value, {
    left: point.x,
    top: point.y - s.fontSize * 0.6,
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    fill: s.fill,
    fontWeight: s.bold ? 'bold' : 'normal',
    fontStyle: s.italic ? 'italic' : 'normal',
    kind: 'text',
    uid: newUid(),
  });
  state.suspend++;
  entry.fabric.add(text);
  state.suspend--;
  entry.fabric.setActiveObject(text);
  text.enterEditing();
  text.selectAll();
  entry.fabric.requestRenderAll();
  pushHistory(entry);
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

async function addImage(entry, dataUrl, kind = 'image', maxRatio = 0.4) {
  const img = await fabric.FabricImage.fromURL(dataUrl);
  const vp = entry.viewport();
  const scale = Math.min(1, (vp.width * maxRatio) / img.width, (vp.height * maxRatio) / img.height);
  const c = visibleCenter(entry);
  img.set({ scaleX: scale, scaleY: scale, kind, uid: newUid() });
  img.set({ left: c.x - (img.width * scale) / 2, top: c.y - (img.height * scale) / 2 });
  state.suspend++;
  entry.fabric.add(img);
  state.suspend--;
  entry.fabric.setActiveObject(img);
  entry.fabric.requestRenderAll();
  pushHistory(entry);
  return img;
}

// ---------- editar texto existente ----------

async function ensureRuns(entry) {
  if (!entry.runs) {
    try { entry.runs = await loadTextRuns(entry); } catch (err) { console.error(err); entry.runs = []; }
  }
  if (state.tool === 'edittext') renderTextHits(entry, state.zoom, onPickRun);
  return entry.runs;
}

function onPickRun(entry, run) {
  const { cover, text } = createTextEdit(entry, run);
  const canvas = entry.fabric;
  state.suspend++;
  canvas.add(cover, text);
  state.suspend--;
  setTool('select');
  canvas.setActiveObject(text);
  text.enterEditing();
  text.setSelectionStart(text.text.length);
  text.setSelectionEnd(text.text.length);
  canvas.requestRenderAll();
  pushHistory(entry);
  return text;
}

// ---------- formulários ----------

function onFormChange() {
  setDirty(true);
}

// ---------- ferramentas e propriedades ----------

function applyToolTo(entry) {
  const canvas = entry.fabric;
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

function setTool(tool) {
  state.tool = tool;
  document.body.className = document.body.className.replace(/\btool-\S+/g, '').trim();
  document.body.classList.add(`tool-${tool}`);
  for (const b of document.querySelectorAll('#tools .tool')) b.classList.toggle('active', b.dataset.tool === tool);
  for (const entry of state.pages) {
    applyToolTo(entry);
    if (tool === 'edittext') ensureRuns(entry);
    else entry.hitLayer.replaceChildren();
  }
  const hints = {
    select: 'Clique num item para mover, redimensionar ou excluir. Clique duas vezes num texto para editar.',
    edittext: 'Passe o mouse sobre o PDF e clique na frase que quer alterar.',
    text: 'Clique na página onde quer escrever.',
    whiteout: 'Arraste sobre a área que quer cobrir.',
    highlight: 'Arraste sobre o trecho que quer destacar.',
    rect: 'Arraste para desenhar o retângulo.',
    pen: 'Desenhe com o mouse. Esc para voltar.',
  };
  $('#hint').textContent = hints[tool] || '';
}

function activeObjects() {
  const entry = state.pages.find((p) => p.fabric.getActiveObject());
  if (!entry) return { entry: null, objects: [] };
  return { entry, objects: entry.fabric.getActiveObjects() };
}

function onSelection(entry) {
  const { objects } = activeObjects();
  $('#prop-delete').disabled = !objects.length;
  const text = objects.find((o) => o instanceof fabric.IText);
  if (text) {
    $('#prop-font').value = text.fontFamily;
    $('#prop-size').value = Math.round(text.fontSize * (text.scaleY || 1));
    $('#prop-color').value = new fabric.Color(text.fill).toHex().replace(/^#?/, '#').slice(0, 7);
    $('#prop-bold').classList.toggle('on', text.fontWeight === 'bold');
    $('#prop-italic').classList.toggle('on', text.fontStyle === 'italic');
  }
  const shape = objects.find((o) => o.kind === 'rect' || o.kind === 'ink');
  if (shape) {
    $('#prop-stroke').value = Math.round(shape.strokeWidth);
    $('#prop-stroke-color').value = new fabric.Color(shape.stroke).toHex().replace(/^#?/, '#').slice(0, 7);
  }
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
  const shapes = objects.filter((o) => o.kind === 'rect' || o.kind === 'ink');
  for (const s of shapes) apply(s);
  if (entry && shapes.length) { entry.fabric.requestRenderAll(); pushHistory(entry); }
  if (state.tool === 'pen') for (const p of state.pages) applyToolTo(p);
}

async function setupPropbar() {
  const fonts = await api.fontFamilies();
  const select = $('#prop-font');
  for (const f of fonts) {
    const opt = new Option(f, f);
    opt.style.fontFamily = f;
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
  $('#prop-bold').addEventListener('click', (e) => {
    const on = !e.currentTarget.classList.contains('on');
    e.currentTarget.classList.toggle('on', on);
    state.textStyle.bold = on;
    applyTextProp((t) => t.set('fontWeight', on ? 'bold' : 'normal'));
  });
  $('#prop-italic').addEventListener('click', (e) => {
    const on = !e.currentTarget.classList.contains('on');
    e.currentTarget.classList.toggle('on', on);
    state.textStyle.italic = on;
    applyTextProp((t) => t.set('fontStyle', on ? 'italic' : 'normal'));
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
  $('#prop-delete').addEventListener('click', deleteSelection);
}

function deleteSelection() {
  const { entry, objects } = activeObjects();
  if (!entry || !objects.length) return;
  if (objects.some((o) => o.isEditing)) return;
  removeObjects(entry, objects);
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
  const first = state.pages[0];
  if (!first) return;
  const w = first.viewport().width;
  const avail = viewerEl.clientWidth - 64;
  setZoom(Math.min(1.5, Math.max(0.5, Math.round((avail / w) * 100) / 100)));
}

// ---------- salvar ----------

function suggestedPath() {
  if (state.savedPath) return state.savedPath;
  const name = (state.file?.name || 'documento.pdf').replace(/\.pdf$/i, '');
  const file = `${name} (editado).pdf`;
  if (state.file?.path) return state.file.path.replace(/[^\\/]+$/, file);
  return file;
}

async function save(saveAs = false, selftestName = null) {
  if (!hasDoc()) return null;
  for (const p of state.pages) {
    const active = p.fabric.getActiveObject();
    if (active?.isEditing) active.exitEditing();
    p.fabric.discardActiveObject();
    p.fabric.requestRenderAll();
  }
  busy('Salvando…');
  try {
    const bytes = await buildPdf(state, (family, variant) => api.getFont(family, variant));
    state.lastSavedBytes = bytes;
    const result = await api.savePdf(bytes, { path: state.savedPath, saveAs, suggestedPath: suggestedPath(), selftestName });
    if (!result) return null;
    state.savedPath = result.path;
    setDirty(false);
    toast(`Salvo em ${result.name}`);
    return result;
  } catch (err) {
    console.error(err);
    toast(`Não consegui salvar: ${err?.message || err}`, true);
    return null;
  } finally {
    busy(false);
  }
}

// ---------- assinatura ----------

function signatureDialog() {
  return new Promise((resolve) => {
    const modal = $('#sig-modal');
    const canvas = $('#sig-canvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let drawing = false;
    let drew = false;
    let last = null;
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
    };
    const down = (e) => { drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); };
    const move = (e) => {
      if (!drawing) return;
      const p = pos(e);
      ctx.strokeStyle = $('#sig-color').value;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
      drew = true;
    };
    const up = () => { drawing = false; };
    const clear = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); drew = false; };
    const close = (value) => {
      modal.hidden = true;
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      $('#sig-clear').onclick = $('#sig-cancel').onclick = $('#sig-ok').onclick = null;
      resolve(value);
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    $('#sig-clear').onclick = clear;
    $('#sig-cancel').onclick = () => close(null);
    $('#sig-ok').onclick = () => close(drew ? trimCanvas(canvas) : null);
    modal.hidden = false;
  });
}

function trimCanvas(canvas) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 6;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d').drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

function bytesToDataUrl(bytes, mime) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes], { type: mime }));
  });
}

// ---------- ações dos botões ----------

async function onToolButton(tool) {
  if (!hasDoc()) { toast('Abra um PDF primeiro.'); return; }
  const entry = state.current || state.pages[0];
  if (tool === 'image') {
    const file = await api.pickImage();
    if (!file) return;
    setTool('select');
    await addImage(entry, await bytesToDataUrl(file.data, file.mime));
    return;
  }
  if (tool === 'signature') {
    const dataUrl = await signatureDialog();
    if (!dataUrl) return;
    setTool('select');
    await addImage(entry, dataUrl, 'signature', 0.3);
    return;
  }
  setTool(tool);
}

function isTypingTarget(el) {
  if (!el) return false;
  if (el.closest?.('.form-layer')) return true;
  return ['INPUT', 'SELECT'].includes(el.tagName) || (el.tagName === 'TEXTAREA' && !el.hasAttribute('data-fabric'));
}

function anyTextEditing() {
  return state.pages.some((p) => p.fabric.getActiveObject()?.isEditing);
}

function setupEvents() {
  $('#btn-open').addEventListener('click', async () => openFile(await api.openPdf()));
  $('#btn-open-empty').addEventListener('click', async () => openFile(await api.openPdf()));
  $('#btn-save').addEventListener('click', () => save(false));
  $('#btn-saveas').addEventListener('click', () => save(true));
  $('#btn-insert').addEventListener('click', async () => insertDocs(await api.pickPdfs()));
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);
  $('#btn-zoom-in').addEventListener('click', () => stepZoom(1));
  $('#btn-zoom-out').addEventListener('click', () => stepZoom(-1));
  for (const b of document.querySelectorAll('#tools .tool')) {
    b.addEventListener('click', () => onToolButton(b.dataset.tool));
  }

  viewerEl.addEventListener('scroll', () => requestAnimationFrame(trackCurrentOnScroll), { passive: true });
  viewerEl.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    stepZoom(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
  window.addEventListener('resize', () => { for (const p of state.pages) p.fabric.calcOffset(); });

  window.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (ctrl && key === 's') { e.preventDefault(); save(e.shiftKey); return; }
    if (ctrl && key === 'o') { e.preventDefault(); $('#btn-open').click(); return; }
    if (isTypingTarget(e.target) || anyTextEditing()) return;
    if (ctrl && key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (ctrl && (key === '=' || key === '+')) { e.preventDefault(); stepZoom(1); }
    else if (ctrl && key === '-') { e.preventDefault(); stepZoom(-1); }
    else if (key === 'delete' || key === 'backspace') { e.preventDefault(); deleteSelection(); }
    else if (key === 'escape') setTool('select');
    else if (key.startsWith('arrow')) {
      const { entry, objects } = activeObjects();
      if (!entry || !objects.length) return;
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1) / state.zoom;
      const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0;
      const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0;
      const target = entry.fabric.getActiveObject();
      target.set({ left: target.left + dx, top: target.top + dy });
      target.setCoords();
      entry.fabric.requestRenderAll();
      pushHistory(entry);
    }
  });

  // Arrastar um PDF para a janela abre o arquivo
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
    const pdfs = [...e.dataTransfer.files].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!pdfs.length) { toast('Solte um arquivo .pdf.', true); return; }
    const files = await Promise.all(pdfs.map(async (f) => ({ name: f.name, path: null, data: new Uint8Array(await f.arrayBuffer()) })));
    if (hasDoc() && window.confirm(`Inserir ${files.length > 1 ? 'esses PDFs' : 'esse PDF'} no final do documento atual?\n\n(Cancelar = abrir em vez de inserir)`)) {
      insertDocs(files);
    } else {
      openFile(files[0]);
    }
  });

  api.onFileOpened((file) => openFile(file));
}

// ---------- início ----------

async function start() {
  setupEvents();
  await setupPropbar();
  setTool('select');
  updateButtons();
  updateTitle();

  const test = await api.testConfig();
  if (test) {
    const { runSelftest } = await import('./selftest.js');
    await runSelftest({
      state, api, fabric, openFile, insertDocs, movePage, rotatePage, deletePage, addText, addImage,
      makeShape, ensureRuns, onPickRun, pushHistory, undo, redo, save, setZoom, setTool, renderPage, fitWidth,
    }, test);
    return;
  }

  const initial = await api.initialFile();
  if (initial) await openFile(initial);
}

start();
