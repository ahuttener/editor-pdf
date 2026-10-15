// Tela do editor: páginas com rolagem, ferramentas de anotação/assinatura e o modo de organizar páginas.
import { t, getLang } from './i18n.js';
import { icon } from './icons.js';
import { $, h, esc, sheet, confirmSheet, promptSheet, toast, busy, pickFiles, pagesLabel } from './ui.js';
import { fabric, TEXT_BASELINE_RATIO } from './fabric-setup.js';
import { loadPdf, isPasswordError, buildPdf, imagesToPdf, thumbnail, readForm, blankPdf } from './pdf.js';
import { engine } from './engine.js';
import { saveDoc, shareDoc, printPdf } from './storage.js';
import { chooseSignature } from './signature.js';

const TEXT_COLORS = ['#111827', '#c8141c', '#1c4a82', '#187434', '#7c3aed', '#ffffff'];
const HL_COLORS = ['#ffe14d', '#8ef07a', '#ff8ad8', '#7fd8ff'];
const FONT = 'Helvetica, Arial, sans-serif';
const PAD = 12; // margem lateral das páginas na tela

const MODES = {
  annotate: [
    ['select', 'hand', 'Selecionar'],
    ['text', 'type', 'Texto'],
    ['highlight', 'highlighter', 'Marca-texto'],
    ['underline', 'underline', 'Sublinhar'],
    ['strike', 'strike', 'Riscar'],
    ['pen', 'pen', 'Caneta'],
    ['shape', 'square', 'Formas'],
    ['note', 'note', 'Nota'],
    ['stamp', 'stamp', 'Carimbo'],
    ['image', 'image', 'Imagem'],
    ['cover', 'cover', 'Cobrir'],
    ['redact', 'redact', 'Tarjar'],
    ['search', 'search', 'Buscar'],
  ],
  edit: [
    ['edittext', 'edit', 'Editar frase'],
    ['text', 'type', 'Texto novo'],
    ['select', 'hand', 'Selecionar'],
    ['search', 'search', 'Buscar'],
  ],
  sign: [
    ['select', 'hand', 'Selecionar'],
    ['sign', 'signature', 'Assinatura'],
    ['text', 'type', 'Texto'],
    ['date', 'calendar', 'Data'],
    ['x', 'x', 'Marcar X'],
    ['stamp', 'stamp', 'Carimbo'],
  ],
  forms: [
    ['fill', 'form', 'Preencher'],
    ['field-text', 'type', 'Novo campo'],
    ['field-check', 'check', 'Nova caixa'],
    ['select', 'hand', 'Selecionar'],
  ],
};
const HINTS = {
  text: 'Toque na página para escrever',
  highlight: 'Arraste sobre o texto para marcar',
  underline: 'Arraste sobre o texto para sublinhar',
  strike: 'Arraste sobre o texto para riscar',
  pen: 'Desenhe com o dedo',
  cover: 'Arraste para cobrir (o que ficar embaixo é apagado ao salvar)',
  redact: 'Arraste sobre o que deve sumir (é apagado de verdade ao salvar)',
  note: 'Toque onde quer a nota',
  edittext: 'Toque numa frase do PDF para editar',
  fill: 'Toque num campo para preencher',
  'field-text': 'Arraste para criar um campo de texto',
  'field-check': 'Toque para criar uma caixa de marcar',
};
const SHAPES = [['rect', 'square', 'Retângulo'], ['ellipse', 'circle', 'Elipse'], ['line', 'line', 'Linha'], ['arrow', 'arrow', 'Seta']];
const STAMPS = [
  ['APROVADO', '#187434'], ['REPROVADO', '#b3261e'], ['PAGO', '#187434'], ['RECEBIDO', '#1c4a82'],
  ['CONFIDENCIAL', '#b3261e'], ['URGENTE', '#b3261e'], ['CÓPIA', '#1c4a82'], ['RASCUNHO', '#6b7280'],
];
// Ferramentas de arrastar um retângulo (ver mouse:down)
const DRAG_RECT = ['highlight', 'underline', 'strike', 'cover', 'redact', 'field-text'];
// Propriedades extras gravadas em cada objeto
const PROPS = ['kind', 'fieldName', 'editId'];

// Retângulo do PDF -> retângulo na tela [x0, y0, x1, y1] (o pdf.js 6 não tem mais convertToViewportRectangle)
function vpRect(vp, [a, b, c, d]) {
  const [x0, y0] = vp.convertToViewportPoint(a, b);
  const [x1, y1] = vp.convertToViewportPoint(c, d);
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

let current = null; // há só um editor aberto por vez

export function editorIsOpen() { return !!current; }
export function editorBack() { current?.back(); }

export async function openEditor({ name, id = null, bytes, mode = 'annotate', protection = null, onExit }) {
  const done = busy(t('Abrindo…'));
  let pdf;
  try {
    pdf = await loadPdf(bytes);
  } catch (err) {
    done();
    toast(isPasswordError(err) ? t('Este PDF tem senha. Abra-o no computador para remover a senha.') : t('Não foi possível abrir este arquivo.'), 'error');
    return;
  }
  done();

  const doc = { name, id, protection, sources: new Map([['s0', { bytes, pdf }]]), pages: [], formValues: new Map(), form: null };
  for (let i = 0; i < pdf.numPages; i++) doc.pages.push({ key: `s0:${i}`, src: 's0', index: i, rotate: 0, objects: [] });
  let srcCounter = 1;

  const state = { mode: mode === 'redact' ? 'annotate' : mode, tool: 'select', zoom: 1, dirty: false, undo: [], redo: [], loading: false, shape: 'rect' };
  const colors = { text: TEXT_COLORS[0], pen: '#1c4a82', hl: HL_COLORS[0], line: '#c8141c' };

  const root = h(`<section class="editor" aria-label="${esc(name)}">
    <header class="ed-top">
      <button class="icon-btn" data-act="back" aria-label="${t('Voltar')}">${icon('back')}</button>
      <div class="ed-title"><strong></strong><small></small></div>
      <button class="icon-btn" data-act="print" aria-label="${t('Imprimir')}">${icon('printer')}</button>
      <button class="icon-btn" data-act="undo" aria-label="${t('Desfazer')}" disabled>${icon('undo')}</button>
      <button class="icon-btn" data-act="redo" aria-label="${t('Refazer')}" disabled>${icon('redo')}</button>
      <button class="btn btn-primary btn-sm" data-act="save">${icon('check', { size: 18, stroke: 2.4 })}<span>${t('Salvar')}</span></button>
    </header>
    <div class="ed-modes" role="tablist">
      <button role="tab" data-mode="annotate">${icon('highlighter', { size: 18 })}<span>${t('Anotar')}</span></button>
      <button role="tab" data-mode="edit">${icon('edit', { size: 18 })}<span>${t('Editar')}</span></button>
      <button role="tab" data-mode="sign">${icon('signature', { size: 18 })}<span>${t('Assinar')}</span></button>
      <button role="tab" data-mode="forms">${icon('form', { size: 18 })}<span>${t('Campos')}</span></button>
      <button role="tab" data-mode="pages">${icon('pages', { size: 18 })}<span>${t('Páginas')}</span></button>
    </div>
    <div class="ed-scroll"><div class="ed-pages"></div></div>
    <div class="ed-grid" hidden></div>
    <div class="ed-float">
      <div class="ed-hint" hidden></div>
      <div class="ed-selbar" hidden>
        <button data-sel="color" aria-label="${t('Cor')}"><span class="dot"></span><span>${t('Cor')}</span></button>
        <button data-sel="smaller" class="txt-only" aria-label="A-">A<sup>−</sup></button>
        <button data-sel="bigger" class="txt-only" aria-label="A+">A<sup>+</sup></button>
        <button data-sel="dup">${icon('copy', { size: 19 })}<span>${t('Duplicar')}</span></button>
        <button data-sel="del" class="danger">${icon('trash', { size: 19 })}<span>${t('Excluir')}</span></button>
      </div>
      <div class="ed-pageind" hidden></div>
    </div>
    <nav class="ed-tools"></nav>
  </section>`);
  document.body.append(root);
  document.body.classList.add('editing');
  requestAnimationFrame(() => root.classList.add('open'));

  const scroller = $('.ed-scroll', root);
  const pagesEl = $('.ed-pages', root);
  const gridEl = $('.ed-grid', root);
  const toolsEl = $('.ed-tools', root);
  const selbar = $('.ed-selbar', root);
  const hintEl = $('.ed-hint', root);
  const pageInd = $('.ed-pageind', root);

  const setTitle = () => {
    $('.ed-title strong', root).textContent = doc.name;
    $('.ed-title small', root).textContent = pagesLabel(doc.pages.length);
  };
  setTitle();

  // ---------- Páginas na tela ----------
  const views = new Map(); // key -> { el, img, fabWrap, canvas (fabric), vp, task }
  const pdfPage = (p) => doc.sources.get(p.src).pdf.getPage(p.index + 1);

  async function viewportOf(p, scale = 1) {
    const pg = await pdfPage(p);
    return pg.getViewport({ scale, rotation: (pg.rotate + p.rotate) % 360 });
  }

  const baseWidth = () => Math.max(200, scroller.clientWidth - PAD * 2);

  let io;
  async function layout() {
    io?.disconnect();
    for (const key of [...views.keys()]) unmount(key);
    pagesEl.innerHTML = '';
    views.clear();
    const bw = baseWidth() * state.zoom;
    for (const p of doc.pages) {
      const vp = await viewportOf(p);
      const w = Math.round(bw);
      const hgt = Math.round((bw * vp.height) / vp.width);
      const el = h(`<div class="pg" style="width:${w}px;height:${hgt}px"><canvas class="pg-img"></canvas><div class="pg-fab"></div><div class="pg-form"></div><span class="pg-num">${doc.pages.indexOf(p) + 1}</span></div>`);
      el.dataset.key = p.key;
      pagesEl.append(el);
      views.set(p.key, { el, vp, w, h: hgt, rot: p.rotate, mounted: false });
    }
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const key = e.target.dataset.key;
        if (e.isIntersecting) mount(key); else unmount(key);
      }
    }, { root: scroller, rootMargin: '900px 0px' });
    for (const v of views.values()) io.observe(v.el);
    updatePageInd();
  }

  const pageByKey = (key) => doc.pages.find((p) => p.key === key);

  async function mount(key) {
    const v = views.get(key);
    const p = pageByKey(key);
    if (!v || !p || v.mounted) return;
    v.mounted = true;
    // Imagem da página
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const img = $('.pg-img', v.el);
    const pg = await pdfPage(p);
    if (!v.mounted) return;
    const scale = (v.w * dpr) / v.vp.width;
    const rvp = pg.getViewport({ scale, rotation: (pg.rotate + p.rotate) % 360 });
    img.width = Math.round(rvp.width);
    img.height = Math.round(rvp.height);
    v.task = pg.render({ canvasContext: img.getContext('2d'), canvas: img, viewport: rvp, annotationMode: 1 });
    v.task.promise.catch(() => {});
    // Camada de edição
    const wrap = $('.pg-fab', v.el);
    const c = document.createElement('canvas');
    wrap.append(c);
    const canvas = new fabric.Canvas(c, { width: v.w, height: v.h, selection: false, preserveObjectStacking: true, allowTouchScrolling: false });
    canvas.setZoom(v.w / v.vp.width);
    v.canvas = canvas;
    state.loading = true;
    await canvas.loadFromJSON({ objects: p.objects });
    state.loading = false;
    canvas.requestRenderAll();
    wireCanvas(key, canvas);
    applyToolTo(v);
    renderFormLayer(key);
  }

  function unmount(key) {
    const v = views.get(key);
    if (!v || !v.mounted) return;
    v.mounted = false;
    v.task?.cancel();
    const img = $('.pg-img', v.el);
    img.width = 0; img.height = 0;
    if (v.canvas) {
      v.canvas.dispose();
      v.canvas = null;
      $('.pg-fab', v.el).innerHTML = '';
    }
  }

  // ---------- Histórico ----------
  function commit(key) {
    if (state.loading) return;
    const v = views.get(key);
    const p = pageByKey(key);
    if (!v?.canvas || !p) return;
    const after = v.canvas.toObject(PROPS).objects;
    state.undo.push({ type: 'page', key, before: p.objects, after });
    state.redo = [];
    p.objects = after;
    markDirty();
  }

  const snapshotPages = () => doc.pages.map((p) => ({ ...p }));
  function commitDoc(before) {
    state.undo.push({ type: 'doc', before, after: snapshotPages() });
    state.redo = [];
    markDirty();
  }

  function markDirty() {
    state.dirty = true;
    $('[data-act="undo"]', root).disabled = !state.undo.length;
    $('[data-act="redo"]', root).disabled = !state.redo.length;
  }

  async function reloadPage(key) {
    const v = views.get(key);
    const p = pageByKey(key);
    if (!v?.canvas || !p) return;
    state.loading = true;
    v.canvas.discardActiveObject();
    await v.canvas.loadFromJSON({ objects: p.objects });
    state.loading = false;
    v.canvas.requestRenderAll();
  }

  async function step(from, to, field) {
    const entry = from.pop();
    if (!entry) return;
    to.push(entry);
    if (entry.type === 'page') {
      const p = pageByKey(entry.key);
      if (p) p.objects = entry[field];
      await reloadPage(entry.key);
    } else {
      doc.pages = entry[field].map((p) => ({ ...p }));
      setTitle();
      if (state.mode === 'pages') await renderGrid(); else await layout();
    }
    state.dirty = true;
    $('[data-act="undo"]', root).disabled = !state.undo.length;
    $('[data-act="redo"]', root).disabled = !state.redo.length;
    hideSelbar();
  }

  // ---------- Ferramentas ----------
  function renderTools() {
    if (state.mode === 'pages') {
      toolsEl.classList.remove('many');
      toolsEl.innerHTML = `<button class="tool wide" data-page-add="pdf">${icon('file')}<span>${t('PDF')}</span></button>
        <button class="tool wide" data-page-add="img">${icon('images')}<span>${t('Imagem')}</span></button>
        <button class="tool wide" data-page-add="blank">${icon('plus')}<span>${t('Em branco')}</span></button>`;
      return;
    }
    const list = MODES[state.mode];
    toolsEl.classList.toggle('many', list.length > 6);
    const shapeIcon = SHAPES.find(([id]) => id === state.shape)[1];
    toolsEl.innerHTML = (COLOR_TOOLS.includes(state.tool) ? `<button class="tool" data-tool-color aria-label="${t('Cor')}"><span class="dot big" style="--c:${toolColor()}"></span><span>${t('Cor')}</span></button>` : '')
      + list.map(([id, ic, label]) => `<button class="tool ${state.tool === id ? 'on' : ''}" data-tool="${id}">${icon(id === 'shape' ? shapeIcon : ic)}<span>${t(label)}</span></button>`).join('');
  }

  const COLOR_TOOLS = ['text', 'pen', 'highlight', 'underline', 'strike', 'shape', 'note'];
  const toolColor = () => ({ pen: colors.pen, shape: colors.pen, highlight: colors.hl, underline: colors.line, strike: colors.line }[state.tool] || colors.text);

  // keep: canvas cujo objeto ativo deve continuar selecionado (ex.: texto recém-criado em edição)
  function setTool(tool, keep = null) {
    state.tool = tool;
    root.dataset.tool = tool;
    for (const v of views.values()) {
      if (!v.canvas) continue;
      if (v.canvas !== keep) { v.canvas.discardActiveObject(); v.canvas.requestRenderAll(); }
      applyToolTo(v);
    }
    if (!keep) hideSelbar();
    renderTools();
    const hint = HINTS[tool];
    hintEl.hidden = !hint;
    if (hint) hintEl.textContent = t(hint);
  }

  function applyToolTo(v) {
    const c = v.canvas;
    if (!c) return;
    const drawing = state.tool === 'pen';
    c.isDrawingMode = drawing;
    if (drawing) {
      c.freeDrawingBrush = new fabric.PencilBrush(c);
      c.freeDrawingBrush.color = colors.pen;
      c.freeDrawingBrush.width = 2.2;
    }
    const active = state.tool !== 'select' || !!c.getActiveObject();
    v.el.classList.toggle('live', active);
    c.skipTargetFind = !['select', 'pen', 'edittext'].includes(state.tool);
  }

  function wireCanvas(key, canvas) {
    const v = views.get(key);
    canvas.on('object:added', (e) => { if (!state.loading && !e.target?._creating) commit(key); });
    canvas.on('object:modified', () => commit(key));
    canvas.on('object:removed', () => { if (!state.loading) commit(key); });
    canvas.on('text:editing:entered', () => keepVisibleSoon());
    canvas.on('text:changed', (e) => { growCover(canvas, e.target); keepVisible(); });
    canvas.on('object:resizing', (e) => growCover(canvas, e.target));
    canvas.on('text:editing:exited', (e) => {
      const obj = e.target;
      // texto apagado por inteiro: remove depois que o fabric termina de fechar a edição (removê-lo no meio quebra)
      if (obj && !obj.text.trim()) setTimeout(() => { canvas.remove(obj); canvas.requestRenderAll(); }); else commit(key);
    });
    canvas.on('selection:created', () => { showSelbar(key); applyToolTo(v); });
    canvas.on('selection:updated', () => showSelbar(key));
    canvas.on('selection:cleared', () => { hideSelbar(); applyToolTo(v); });

    let drag = null;
    canvas.on('mouse:down', async (e) => {
      const pt = canvas.getScenePoint(e.e);
      const tool = state.tool;
      if (tool === 'text') {
        const obj = new fabric.IText('', { left: pt.x, top: pt.y - 8, fontFamily: FONT, fontSize: 14, fill: colors.text, kind: 'text', editingBorderColor: '#0b63d8', cursorColor: '#0b63d8' });
        obj._creating = true;
        canvas.add(obj);
        obj._creating = false;
        canvas.setActiveObject(obj);
        setTool('select', canvas);
        obj.enterEditing();
        obj.hiddenTextarea?.focus();
        showSelbar(key);
        return;
      }
      if (tool === 'note') {
        const note = new fabric.Textbox('', {
          left: pt.x, top: pt.y, width: 150, fontFamily: FONT, fontSize: 11, fill: colors.text, backgroundColor: '#fff3a8',
          kind: 'note', editingBorderColor: '#0b63d8', cursorColor: '#0b63d8', splitByGrapheme: false,
        });
        note._creating = true;
        canvas.add(note);
        note._creating = false;
        canvas.setActiveObject(note);
        setTool('select', canvas);
        note.enterEditing();
        note.hiddenTextarea?.focus();
        showSelbar(key);
        return;
      }
      if (tool === 'edittext') {
        if (e.target) return; // já é um texto editado: o fabric seleciona/edita/redimensiona
        await editTextAt(key, pt, e.e);
        return;
      }
      if (tool === 'field-check') {
        const name = await askFieldName('check');
        if (!name) return;
        const box = fieldBox({ left: pt.x - 7, top: pt.y - 7, width: 14, height: 14, kind: 'field-check', fieldName: name });
        canvas.add(box);
        return;
      }
      if (DRAG_RECT.includes(tool)) {
        const look = {
          highlight: { fill: colors.hl, opacity: 0.42 },
          underline: { fill: colors.line, opacity: 0.35 },
          strike: { fill: colors.line, opacity: 0.35 },
          cover: { fill: '#ffffff', opacity: 1, stroke: '#9ca3af', strokeWidth: 0.6, strokeDashArray: [3, 2] },
          redact: { fill: '#000000', opacity: 1 },
          'field-text': { fill: 'rgba(28,74,130,0.08)', stroke: '#1c4a82', strokeWidth: 0.8, strokeDashArray: [4, 2] },
        }[tool];
        const rect = new fabric.Rect({ left: pt.x, top: pt.y, width: 1, height: 1, strokeWidth: 0, ...look, kind: tool, selectable: true });
        rect._creating = true;
        canvas.add(rect);
        drag = { rect, x: pt.x, y: pt.y };
        return;
      }
      if (tool === 'shape') {
        const style = { stroke: colors.pen, strokeWidth: 2, fill: '', kind: 'shape', strokeUniform: true };
        const obj = state.shape === 'rect' ? new fabric.Rect({ left: pt.x, top: pt.y, width: 1, height: 1, ...style })
          : state.shape === 'ellipse' ? new fabric.Ellipse({ left: pt.x, top: pt.y, rx: 0.5, ry: 0.5, ...style })
            : new fabric.Line([pt.x, pt.y, pt.x, pt.y], { ...style, strokeLineCap: 'round' });
        obj._creating = true;
        canvas.add(obj);
        drag = { shape: obj, x: pt.x, y: pt.y };
      }
    });
    canvas.on('mouse:move', (e) => {
      if (!drag) return;
      const pt = canvas.getScenePoint(e.e);
      if (drag.rect) {
        drag.rect.set({ left: Math.min(pt.x, drag.x), top: Math.min(pt.y, drag.y), width: Math.abs(pt.x - drag.x), height: Math.abs(pt.y - drag.y) });
      } else if (drag.shape.type === 'line') {
        drag.shape.set({ x2: pt.x, y2: pt.y });
        drag.end = pt;
      } else if (drag.shape.type === 'ellipse') {
        drag.shape.set({ left: Math.min(pt.x, drag.x), top: Math.min(pt.y, drag.y), rx: Math.abs(pt.x - drag.x) / 2, ry: Math.abs(pt.y - drag.y) / 2 });
      } else {
        drag.shape.set({ left: Math.min(pt.x, drag.x), top: Math.min(pt.y, drag.y), width: Math.abs(pt.x - drag.x), height: Math.abs(pt.y - drag.y) });
      }
      canvas.requestRenderAll();
    });
    canvas.on('mouse:up', async () => {
      if (!drag) return;
      const drag0 = drag;
      drag = null;
      const discard = (o) => { state.loading = true; canvas.remove(o); state.loading = false; };
      if (drag0.shape) {
        const o = drag0.shape;
        o._creating = false;
        const end = drag0.end || { x: drag0.x, y: drag0.y };
        const tiny = o.type === 'line' ? Math.hypot(end.x - drag0.x, end.y - drag0.y) < 6 : (o.width || o.rx * 2) < 4 && (o.height || o.ry * 2) < 4;
        if (tiny) return discard(o);
        if (state.shape === 'arrow') {
          // Seta = linha + ponta, num único caminho
          const ang = Math.atan2(end.y - drag0.y, end.x - drag0.x);
          const L = 11;
          const a1 = { x: end.x - L * Math.cos(ang - 0.45), y: end.y - L * Math.sin(ang - 0.45) };
          const a2 = { x: end.x - L * Math.cos(ang + 0.45), y: end.y - L * Math.sin(ang + 0.45) };
          const arrow = new fabric.Path(`M ${drag0.x} ${drag0.y} L ${end.x} ${end.y} M ${a1.x} ${a1.y} L ${end.x} ${end.y} L ${a2.x} ${a2.y}`,
            { stroke: o.stroke, strokeWidth: 2, fill: '', strokeLineCap: 'round', strokeLineJoin: 'round', kind: 'shape' });
          arrow._creating = true;
          discard(o);
          canvas.add(arrow);
          arrow._creating = false;
          arrow.setCoords();
        } else o.setCoords();
        commit(key);
        return;
      }
      const { rect } = drag0;
      rect._creating = false;
      if (['highlight', 'underline', 'strike'].includes(rect.kind)) {
        // Arrastar na horizontal (o gesto natural) marca uma linha inteira de texto
        if (rect.height < 11) rect.set({ height: 13, top: drag0.y - 6.5 });
        if (rect.width < 4) rect.set({ width: 120 });
        if (rect.kind !== 'highlight') {
          // traço fino: embaixo da linha (sublinhar) ou no meio (riscar)
          const top = rect.kind === 'underline' ? rect.top + rect.height - 1.5 : rect.top + rect.height / 2 - 0.7;
          rect.set({ top, height: 1.4, opacity: 1 });
        }
      } else if (rect.width < 4 || rect.height < 3) {
        return discard(rect);
      }
      rect.setCoords();
      if (rect.kind === 'field-text') {
        const name = await askFieldName('text');
        if (!name) return discard(rect);
        state.loading = true;
        canvas.remove(rect);
        state.loading = false;
        canvas.add(fieldBox({ left: rect.left, top: rect.top, width: rect.width, height: Math.max(rect.height, 12), kind: 'field-text', fieldName: name }));
        return;
      }
      commit(key);
    });
    canvas.on('path:created', (e) => { e.path.set({ kind: 'pen' }); });
  }

  // Toque numa página no modo "Selecionar": acha o objeto e liga a camada de edição só nela
  pagesEl.addEventListener('click', (e) => {
    if (state.tool !== 'select') return;
    const pgEl = e.target.closest('.pg');
    if (!pgEl || pgEl.classList.contains('live')) return;
    const v = views.get(pgEl.dataset.key);
    if (!v?.canvas) return;
    const r = pgEl.getBoundingClientRect();
    const zoom = v.canvas.getZoom();
    const pt = new fabric.Point((e.clientX - r.left) / zoom, (e.clientY - r.top) / zoom);
    const hit = [...v.canvas.getObjects()].reverse().find((o) => o.containsPoint(pt));
    if (!hit) return;
    for (const other of views.values()) if (other !== v && other.canvas?.getActiveObject()) other.canvas.discardActiveObject().requestRenderAll();
    v.canvas.setActiveObject(hit);
    v.canvas.requestRenderAll();
    showSelbar(pgEl.dataset.key);
    applyToolTo(v);
  });

  // ---------- Barra do objeto selecionado ----------
  let selKey = null;
  function activeObj() { return selKey ? views.get(selKey)?.canvas?.getActiveObject() : null; }

  function showSelbar(key) {
    selKey = key;
    const obj = activeObj();
    if (!obj) return hideSelbar();
    const isText = obj.type?.toLowerCase().includes('text');
    selbar.classList.toggle('is-text', isText);
    const col = obj.kind === 'pen' || obj.kind === 'shape' ? obj.stroke : obj.fill;
    $('[data-sel="color"]', selbar).hidden = ['cover', 'redact', 'stamp', 'signature', 'image', 'field-text', 'field-check'].includes(obj.kind) || obj.type === 'image';
    $('[data-sel="color"] .dot', selbar).style.setProperty('--c', typeof col === 'string' ? col : '#111827');
    selbar.hidden = false;
    hintEl.hidden = true;
  }
  function hideSelbar() { selbar.hidden = true; selKey = null; }

  selbar.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sel]');
    const obj = activeObj();
    if (!b || !obj) return;
    const key = selKey;
    const canvas = views.get(key).canvas;
    const act = b.dataset.sel;
    if (act === 'del') { canvas.remove(obj); canvas.discardActiveObject(); canvas.requestRenderAll(); hideSelbar(); }
    else if (act === 'dup') {
      const copy = await obj.clone(PROPS);
      copy.set({ left: obj.left + 12, top: obj.top + 12 });
      canvas.add(copy);
      canvas.setActiveObject(copy);
      canvas.requestRenderAll();
    } else if (act === 'bigger' || act === 'smaller') {
      const f = act === 'bigger' ? 1.15 : 1 / 1.15;
      obj.set({ fontSize: Math.max(5, Math.min(120, obj.fontSize * f)) });
      obj.setCoords();
      canvas.requestRenderAll();
      commit(key);
    } else if (act === 'color') {
      const list = obj.kind === 'highlight' ? HL_COLORS : TEXT_COLORS;
      const col = await pickColor(list);
      if (!col) return;
      if (obj.kind === 'pen' || obj.kind === 'shape') obj.set({ stroke: col }); else obj.set({ fill: col });
      canvas.requestRenderAll();
      commit(key);
      showSelbar(key);
    }
  });

  function pickColor(list) {
    return new Promise((resolve) => {
      const s = sheet(`<div class="swatches">${list.map((c) => `<button class="swatch xl" style="--c:${c}" data-c="${c}" aria-label="${c}"></button>`).join('')}</div>`,
        { title: t('Cor'), onClose: (v) => resolve(v || null) });
      s.el.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => s.close(b.dataset.c)));
    });
  }

  // ---------- Inserir no centro da página visível ----------
  function visibleKey() {
    const top = scroller.scrollTop + scroller.clientHeight / 3;
    let best = doc.pages[0]?.key;
    for (const p of doc.pages) {
      const v = views.get(p.key);
      if (v && v.el.offsetTop <= top) best = p.key;
    }
    return best;
  }

  async function insertCentered(make) {
    const key = visibleKey();
    let v = views.get(key);
    if (!v?.canvas) { await mount(key); v = views.get(key); }
    const canvas = v.canvas;
    const obj = await make(v.vp);
    const zoom = canvas.getZoom();
    // Centro da parte da página que está na tela
    const pgTop = v.el.offsetTop - scroller.scrollTop;
    const viewMid = (Math.max(0, -pgTop) + Math.min(v.h, scroller.clientHeight - pgTop)) / 2;
    obj.set({ left: (v.vp.width - obj.getScaledWidth()) / 2, top: Math.max(4, viewMid / zoom - obj.getScaledHeight() / 2) });
    obj.setCoords();
    canvas.add(obj);
    canvas.setActiveObject(obj);
    canvas.requestRenderAll();
    showSelbar(key);
    applyToolTo(v);
  }

  async function addImageObject(dataUrl, kind, maxW) {
    await insertCentered(async (vp) => {
      const img = await fabric.FabricImage.fromURL(dataUrl);
      const s = Math.min(maxW / img.width, (vp.height * 0.5) / img.height, 1.5);
      img.set({ scaleX: s, scaleY: s, kind });
      return img;
    });
  }

  toolsEl.addEventListener('click', async (e) => {
    const colorBtn = e.target.closest('[data-tool-color]');
    if (colorBtn) {
      const list = state.tool === 'highlight' ? HL_COLORS : TEXT_COLORS;
      const col = await pickColor(list);
      if (!col) return;
      if (state.tool === 'pen' || state.tool === 'shape') colors.pen = col;
      else if (state.tool === 'highlight') colors.hl = col;
      else if (state.tool === 'underline' || state.tool === 'strike') colors.line = col;
      else colors.text = col;
      setTool(state.tool);
      return;
    }
    const add = e.target.closest('[data-page-add]');
    if (add) return addPages(add.dataset.pageAdd);
    const b = e.target.closest('[data-tool]');
    if (!b) return;
    const tool = b.dataset.tool;
    if (tool === 'sign') {
      setTool('select');
      const url = await chooseSignature();
      if (url) await addImageObject(url, 'signature', 160);
    } else if (tool === 'image') {
      setTool('select');
      const [file] = await pickFiles({ accept: 'image/*' });
      if (!file) return;
      const url = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
      await addImageObject(url, 'image', 220);
    } else if (tool === 'shape') {
      const shape = await pickFrom(t('Formas'), SHAPES.map(([id, ic, label]) => [id, icon(ic, { size: 26 }), t(label)]));
      if (!shape) return;
      state.shape = shape;
      setTool('shape');
    } else if (tool === 'stamp') {
      setTool('select');
      const label = await pickFrom(t('Carimbo'), STAMPS.map(([text, color]) => [text, '', `<span class="stamp-chip" style="--c:${color}">${esc(t(text))}</span>`]));
      if (!label) return;
      const color = STAMPS.find(([x]) => x === label)[1];
      await insertCentered(async () => {
        const txt = new fabric.FabricText(t(label), { fontFamily: FONT, fontWeight: 'bold', fontSize: 20, fill: color, charSpacing: 80, originX: 'center', originY: 'center' });
        const box = new fabric.Rect({ width: txt.width + 26, height: txt.height + 12, rx: 5, ry: 5, fill: 'rgba(255,255,255,0.01)', stroke: color, strokeWidth: 2.6, originX: 'center', originY: 'center' });
        return new fabric.Group([box, txt], { kind: 'stamp', angle: -8, opacity: 0.9 });
      });
    } else if (tool === 'search') {
      setTool('select');
      await searchFlow();
    } else if (tool === 'date' || tool === 'x') {
      setTool('select');
      await insertCentered(async () => {
        const text = tool === 'x' ? 'X' : new Date().toLocaleDateString(getLang() === 'en' ? 'en-GB' : 'pt-BR');
        return new fabric.IText(text, { fontFamily: FONT, fontSize: tool === 'x' ? 18 : 12, fontWeight: tool === 'x' ? 'bold' : 'normal', fill: colors.text, kind: 'text' });
      });
    } else {
      setTool(state.tool === tool && tool !== 'select' ? 'select' : tool);
    }
  });

  // Lista de opções num painel (ícone + rótulo); devolve o id escolhido
  function pickFrom(title, items) {
    return new Promise((resolve) => {
      const s = sheet(`<div class="pick-grid">${items.map(([id, ic, label]) => `<button data-id="${esc(id)}">${ic}<span>${label}</span></button>`).join('')}</div>`,
        { title, onClose: (v) => resolve(v || null) });
      s.el.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => s.close(b.dataset.id)));
    });
  }

  // ---------- Campos de formulário novos ----------
  function fieldBox({ left, top, width, height, kind, fieldName }) {
    return new fabric.Rect({ left, top, width, height, fill: 'rgba(28,74,130,0.08)', stroke: '#1c4a82', strokeWidth: 0.8, strokeDashArray: [4, 2], kind, fieldName });
  }

  let fieldCount = 0;
  async function askFieldName(type) {
    const existing = new Set([...(doc.form?.fields || []).map((f) => f.name), ...doc.pages.flatMap((p) => p.objects.filter((o) => o.fieldName).map((o) => o.fieldName))]);
    let n = ++fieldCount;
    const prefix = type === 'check' ? t('caixa') : t('campo');
    while (existing.has(`${prefix}${n}`)) n++;
    const name = await promptSheet({ title: type === 'check' ? t('Nova caixa de marcar') : t('Novo campo de texto'), label: t('Nome do campo (aparece para quem preencher)'), value: `${prefix}${n}`, ok: t('Criar') });
    if (!name) return null;
    if (existing.has(name)) { toast(t('Já existe um campo com esse nome.'), 'error'); return null; }
    return name;
  }

  // ---------- Texto original do PDF (editar frase e buscar) ----------
  const textCache = new Map();
  async function textItems(p) {
    const k = `${p.src}:${p.index}:${p.rotate}`;
    if (!textCache.has(k)) {
      const pg = await pdfPage(p);
      const vp = await viewportOf(p);
      const tc = await pg.getTextContent();
      await pg.getOperatorList().catch(() => {}); // carrega as fontes (negrito/itálico); em cache se a página já foi desenhada
      const items = [];
      for (const it of tc.items) {
        if (!it.str?.trim()) continue;
        const [, b, c, d, e, f] = it.transform;
        if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01) continue; // só texto na horizontal
        const size = Math.abs(d) || it.height || 10;
        const [x0, y0, x1, y1] = vpRect(vp, [e, f - size * 0.22, e + it.width, f + size * 0.9]);
        const [bx, by] = vp.convertToViewportPoint(e, f);
        const style = tc.styles[it.fontName] || {};
        let font = null;
        try { if (pg.commonObjs.has(it.fontName)) font = pg.commonObjs.get(it.fontName); } catch {}
        const real = `${font?.name || ''} ${font?.loadedName || ''}`;
        items.push({
          str: it.str, size, left: Math.min(x0, x1), top: Math.min(y0, y1), right: Math.max(x0, x1), bottom: Math.max(y0, y1), baseX: bx, baseY: by,
          family: style.fontFamily || 'sans-serif', bold: !!(font?.bold || font?.black) || /bold|black|heavy|semibold|demi/i.test(real), italic: !!font?.italic || /italic|oblique/i.test(real),
        });
      }
      textCache.set(k, items);
    }
    return textCache.get(k);
  }

  const hex = (r, g, b) => `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
  function sampleColors(v, r) {
    const fallback = { bg: '#ffffff', ink: '#111827' };
    const img = v && $('.pg-img', v.el);
    if (!img?.width) return fallback;
    try {
      const k = img.width / v.vp.width;
      const pad = 3;
      const x0 = Math.max(0, Math.floor((r.left - pad) * k));
      const y0 = Math.max(0, Math.floor((r.top - pad) * k));
      const x1 = Math.min(img.width, Math.ceil((r.right + pad) * k));
      const y1 = Math.min(img.height, Math.ceil((r.bottom + pad) * k));
      const w = x1 - x0;
      const hh = y1 - y0;
      if (w < 4 || hh < 4) return fallback;
      const data = img.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, w, hh).data;
      const ring = [];
      const inner = [];
      const edge = Math.max(1, Math.round(pad * k * 0.6));
      for (let y = 0; y < hh; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const px = [data[i], data[i + 1], data[i + 2]];
          if (x < edge || y < edge || x >= w - edge || y >= hh - edge) ring.push(px); else inner.push(px);
        }
      }
      // fundo = mediana da borda
      const med = (list, c) => list.map((p) => p[c]).sort((a, b) => a - b)[list.length >> 1];
      const bg = [0, 1, 2].map((c) => med(ring, c));
      // tinta = média dos pixels que mais diferem do fundo
      const dist = (p) => Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]);
      const far = inner.filter((p) => dist(p) > 120).sort((a, b) => dist(b) - dist(a)).slice(0, Math.max(8, Math.round(inner.length * 0.05)));
      const ink = far.length ? [0, 1, 2].map((c) => far.reduce((sum, p) => sum + p[c], 0) / far.length) : null;
      return { bg: hex(...bg), ink: ink ? hex(...ink) : fallback.ink };
    } catch { return fallback; }
  }

  // Onde a tinta da frase termina de verdade, lido na imagem da página: há PDFs em que a largura
  // informada pelo pdf.js é menor que o desenho (medidas da fonte erradas) e sobrava o fim da frase
  function inkRight(v, r, bgHex) {
    const img = v && $('.pg-img', v.el);
    if (!img?.width) return r.right;
    try {
      const k = img.width / v.vp.width;
      const bg = [1, 3, 5].map((i) => parseInt(bgHex.slice(i, i + 2), 16));
      const x0 = Math.floor(r.right * k);
      const x1 = Math.min(img.width, Math.ceil((r.right + r.size * 4) * k));
      const y0 = Math.max(0, Math.floor(r.top * k));
      const hh = Math.min(img.height, Math.ceil(r.bottom * k)) - y0;
      if (x1 - x0 < 2 || hh < 2) return r.right;
      const data = img.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, x1 - x0, hh).data;
      const gapMax = Math.max(2, Math.round(r.size * 0.5 * k)); // espaço entre palavras ainda é a mesma frase
      let last = -1;
      for (let x = 0, gap = 0; x < x1 - x0 && gap <= gapMax; x++) {
        let n = 0;
        for (let y = 0; y < hh; y++) {
          const i = (y * (x1 - x0) + x) * 4;
          if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 90) n++;
        }
        if (n >= hh - 1) break; // coluna pintada de cima a baixo = borda de tabela, não letra
        if (n) { last = x; gap = 0; } else gap++;
      }
      return last < 0 ? r.right : (x0 + last + 1) / k + 1;
    } catch { return r.right; }
  }

  // A cobertura da frase acompanha o texto novo na largura (texto maior que o original)
  function growCover(canvas, text) {
    if (!text?.editId) return;
    if (text.type === 'textbox' && text.isEditing) {
      const v = [...views.values()].find((x) => x.canvas === canvas);
      const maxW = Math.max(40, (v ? v.vp.width : 600) - text.left - 18);
      const probe = new fabric.IText(text.text, { fontFamily: text.fontFamily, fontSize: text.fontSize, fontWeight: text.fontWeight, fontStyle: text.fontStyle, charSpacing: text.charSpacing });
      const natural = probe.width + 4;
      const w = Math.min(maxW, Math.max(text.width, natural));
      if (Math.abs(w - text.width) > 0.5) { text.set({ width: w }); text.initDimensions?.(); }
    }
    const cover = canvas.getObjects().find((o) => (o.kind === 'edit-cover' || o.kind === 'ocr-cover') && o.editId === text.editId);
    if (!cover) return;
    text.setCoords();
    const right = text.getBoundingRect().left + text.getBoundingRect().width + 2;
    if (right > cover.left + cover.width) {
      cover.set({ width: right - cover.left });
      cover.setCoords();
      canvas.requestRenderAll();
    }
  }

  async function editTextAt(key, pt, ev) {
    const p = pageByKey(key);
    const canvas = views.get(key)?.canvas;
    if (!p || !canvas) return;
    const items = await textItems(p);
    const hit = items.find((i) => pt.x >= i.left - 2 && pt.x <= i.right + 2 && pt.y >= i.top - 2 && pt.y <= i.bottom + 2);
    if (!hit) return ocrEditAt(key, pt, ev); // sem texto de verdade: pode ser palavra desenhada (contorno)
    const family = /serif/i.test(hit.family) && !/sans/i.test(hit.family) ? 'Times New Roman, serif' : /mono/i.test(hit.family) ? 'Courier New, monospace' : FONT;
    // Cores lidas da própria página: fundo (borda em volta da frase) e tinta (pixels mais escuros/contrastantes)
    const { bg, ink } = sampleColors(views.get(key), hit);
    const inkEnd = inkRight(views.get(key), hit, bg);
    startEdit(key, hit, ev, { family, bg, ink, kind: 'edit-cover', right: Math.max(hit.right, inkEnd) });
  }

  // Palavra desenhada (letras em contorno, sem texto no PDF): lê com OCR a linha tocada e abre a mesma edição.
  // Ao salvar, o desenho das letras que fica dentro da área é apagado (fundo maior e imagens ficam) e a caixa é pintada por cima.
  async function ocrEditAt(key, pt, ev) {
    const p = pageByKey(key);
    const v = views.get(key);
    const stop = busy(t('Lendo o texto do desenho…'));
    let line = null;
    let band = null;
    const S = 3; // ~216 dpi: suficiente para o OCR sem pesar no celular
    try {
      const pg = await pdfPage(p);
      const top = Math.max(0, pt.y - 70);
      const bottom = Math.min(v.vp.height, pt.y + 70);
      const vp = pg.getViewport({ scale: S, rotation: (pg.rotate + p.rotate) % 360, offsetY: -top * S });
      const c = document.createElement('canvas');
      c.width = Math.round(v.vp.width * S);
      c.height = Math.round((bottom - top) * S);
      await pg.render({ canvasContext: c.getContext('2d', { willReadFrequently: true }), canvas: c, viewport: vp, annotationMode: 0 }).promise;
      const png = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
      const { lines } = await engine('ocrImage', { png });
      const tx = pt.x * S;
      const ty = (pt.y - top) * S;
      const near = (b) => Math.max(b.x0 - tx, 0, tx - b.x1) + Math.max(b.y0 - ty, 0, ty - b.y1);
      line = lines.map((l) => ({ ...l, d: near(l.bbox) })).filter((l) => l.d <= 6 * S).sort((a, b) => a.d - b.d)[0] || null;
      band = { c, top, S };
    } catch (err) {
      console.error(err);
    } finally { stop(); }
    if (!line) return toast(t('Nenhum texto aqui. Toque em cima de uma frase.'));
    const { c, top } = band;
    const b = line.bbox;
    const base = line.baseline && line.baseline.y0 > b.y0 ? (line.baseline.y0 + line.baseline.y1) / 2 : b.y1 - (b.y1 - b.y0) * 0.2;
    // tamanho da fonte pela altura das maiúsculas/ascendentes acima da linha de base (~73% do corpo)
    const size = Math.max(4, (base - b.y0) / 0.73 / S);
    // folga em volta da caixa do OCR: pingos dos "i" e bordas das letras escapavam
    const pad = size * 0.08;
    const hit = { str: line.text, size, left: b.x0 / S - pad, right: b.x1 / S + pad, top: b.y0 / S + top - pad, bottom: b.y1 / S + top + pad, baseX: b.x0 / S, baseY: base / S + top };
    const { bg, ink } = sampleColors(v, hit);
    hit.bold = inkDensity(c, b, bg) > 0.3;
    startEdit(key, hit, ev, { family: FONT, bg, ink, kind: 'ocr-cover', right: hit.right });
  }

  // Fração de pixels de tinta na caixa da linha (letra grossa = negrito)
  function inkDensity(c, b, bgHex) {
    try {
      const bg = [1, 3, 5].map((i) => parseInt(bgHex.slice(i, i + 2), 16));
      const w = Math.max(1, Math.round(b.x1 - b.x0));
      const hh = Math.max(1, Math.round(b.y1 - b.y0));
      const data = c.getContext('2d', { willReadFrequently: true }).getImageData(Math.round(b.x0), Math.round(b.y0), w, hh).data;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 120) n++;
      return n / (w * hh);
    } catch { return 0; }
  }

  // Abre a edição de uma frase: cobertura com a cor do fundo + caixa de texto no lugar da original
  function startEdit(key, hit, ev, { family, bg, ink, kind, right }) {
    const canvas = views.get(key).canvas;
    state.loading = true;
    // A cobertura apaga a frase original ao salvar (só o texto; linhas de tabela ficam)
    const cover = new fabric.Rect({ left: hit.left - 2, top: hit.top - 1, width: right - hit.left + 5, height: hit.bottom - hit.top + 2, fill: bg, strokeWidth: 0, kind, selectable: false, evented: false });
    const editId = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    cover.set({ editId });
    // Caixa de texto: as alças dos lados mudam a largura e o texto quebra linha sozinho
    const text = new fabric.Textbox(hit.str, {
      left: hit.baseX, top: hit.baseY - hit.size * TEXT_BASELINE_RATIO, fontFamily: family, fontSize: hit.size, fill: ink,
      fontWeight: hit.bold ? 'bold' : 'normal', fontStyle: hit.italic ? 'italic' : 'normal', kind: 'text', editId,
      editingBorderColor: '#0b63d8', cursorColor: '#0b63d8', cursorWidth: 2, splitByGrapheme: false,
    });
    // largura inicial = a frase original (ou o texto medido, se for maior), para não quebrar linha de cara
    // (medida numa linha só: a fonte de substituição costuma ser mais larga que a original)
    const probe = new fabric.IText(hit.str, { fontFamily: family, fontSize: hit.size, fontWeight: text.fontWeight, fontStyle: text.fontStyle });
    const maxW = Math.max(40, views.get(key).vp.width - text.left - 18);
    text.set({ width: Math.min(maxW, Math.max(hit.right - hit.left, probe.width) + 4) });
    text.initDimensions?.();
    text.setControlsVisibility({ mt: false, mb: false, mtr: false });
    canvas.add(cover);
    canvas.add(text);
    state.loading = false;
    commit(key);
    canvas.setActiveObject(text);
    text.enterEditing();
    growCover(canvas, text);
    // cursor piscando no ponto tocado (sem selecionar tudo, que esconde o cursor)
    let at = text.text.length;
    try { if (ev) at = text.getSelectionStartFromPointer(ev); } catch {}
    text.selectionStart = at;
    text.selectionEnd = at;
    text.hiddenTextarea?.focus();
    if (text.hiddenTextarea) text.hiddenTextarea.selectionStart = text.hiddenTextarea.selectionEnd = at;
    text.initDelayedCursor?.(true);
    canvas.requestRenderAll();
    showSelbar(key);
  }

  const fold = (x) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  async function searchFlow() {
    const q = await promptSheet({ title: t('Buscar no documento'), label: t('Palavra ou frase'), ok: t('Buscar') });
    if (!q) return;
    const needle = fold(q);
    const stop = busy(t('Buscando…'));
    const found = [];
    try {
      for (const [n, p] of doc.pages.entries()) {
        for (const it of await textItems(p)) {
          const hay = fold(it.str);
          let i = hay.indexOf(needle);
          while (i >= 0) {
            const w = it.right - it.left;
            found.push({ key: p.key, page: n + 1, text: it.str, left: it.left + (w * i) / hay.length, right: it.left + (w * (i + needle.length)) / hay.length, top: it.top, bottom: it.bottom });
            i = hay.indexOf(needle, i + 1);
          }
        }
      }
    } finally { stop(); }
    if (!found.length) return toast(t('Nada encontrado para "{q}".', { q }));
    showHit(found[0]);
    if (found.length === 1) return;
    const s = sheet(`<p class="sheet-text">${esc(t('{n} resultado(s).', { n: found.length }))}</p>
      <ul class="pick-list">${found.slice(0, 200).map((r, i) => `<li><button data-i="${i}"><span><strong>${esc(t('Página {n}', { n: r.page }))}</strong><small>${esc(r.text)}</small></span></button></li>`).join('')}</ul>`,
    { title: t('Resultados') });
    s.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      s.close();
      showHit(found[Number(b.dataset.i)]);
    });
  }

  function showHit(r) {
    const v = views.get(r.key);
    if (!v) return;
    const k = v.w / v.vp.width;
    pagesEl.querySelectorAll('.search-hit').forEach((x) => x.remove());
    const mark = h(`<div class="search-hit" style="left:${r.left * k - 2}px;top:${r.top * k - 2}px;width:${(r.right - r.left) * k + 4}px;height:${(r.bottom - r.top) * k + 4}px"></div>`);
    v.el.append(mark);
    scroller.scrollTo({ top: Math.max(0, v.el.offsetTop + r.top * k - scroller.clientHeight / 3), left: Math.max(0, v.el.offsetLeft + r.left * k - 40), behavior: 'smooth' });
    setTimeout(() => mark.remove(), 4000);
  }

  // ---------- Preencher formulário ----------
  async function loadForm() {
    if (doc.form) return doc.form;
    const base = doc.sources.get('s0');
    doc.form = { src: 's0', ...(await readForm(base.bytes)) };
    return doc.form;
  }

  const fieldValue = (f) => (doc.formValues.has(f.name) ? doc.formValues.get(f.name) : f.value);

  function renderFormLayer(key) {
    const v = views.get(key);
    const p = pageByKey(key);
    const layer = v && $('.pg-form', v.el);
    if (!layer) return;
    layer.innerHTML = '';
    if (!doc.form || p.src !== doc.form.src) return;
    const k = v.w / v.vp.width;
    for (const f of doc.form.fields) {
      for (const w of f.widgets) {
        if (w.index !== p.index) continue;
        const [x0, y0, x1, y1] = vpRect(v.vp, w.rect);
        const val = fieldValue(f);
        let label = '';
        if (f.type === 'check') label = val ? '✓' : '';
        else if (f.type === 'radio') label = val && val === w.option ? '●' : '';
        else label = String(val || '');
        const el = h(`<button class="fld fld-${f.type}" style="left:${Math.min(x0, x1) * k}px;top:${Math.min(y0, y1) * k}px;width:${Math.abs(x1 - x0) * k}px;height:${Math.abs(y1 - y0) * k}px" ${f.readOnly ? 'disabled' : ''}></button>`);
        el.textContent = label;
        el.setAttribute('aria-label', f.name);
        el.addEventListener('click', () => fillField(f, w));
        layer.append(el);
      }
    }
  }

  const refreshFormLayers = () => { for (const [key, v] of views) if (v.mounted) renderFormLayer(key); };

  async function fillField(f, w) {
    let value;
    if (f.type === 'check') value = !fieldValue(f);
    else if (f.type === 'radio') value = w.option ?? f.options[0];
    else if (f.type === 'dropdown' || f.type === 'list') {
      value = await pickFrom(f.name, [['', '', `<span>${esc(t('(vazio)'))}</span>`], ...f.options.map((o) => [o, '', `<span>${esc(o)}</span>`])]);
      if (value === null) return;
    } else {
      value = await promptSheet({ title: f.name, label: t('Valor do campo'), value: String(fieldValue(f) || ''), ok: t('OK') });
      if (value === null) return;
    }
    doc.formValues.set(f.name, value);
    markDirty();
    refreshFormLayers();
  }

  // ---------- Modo páginas ----------
  async function renderGrid() {
    gridEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    doc.pages.forEach((p, i) => {
      const card = h(`<div class="pcard" data-key="${p.key}">
        <div class="pthumb"><canvas></canvas><span class="pg-num">${i + 1}</span></div>
        <div class="pacts">
          <button data-pa="left" aria-label="${t('Mover para a esquerda')}" ${i === 0 ? 'disabled' : ''}>${icon('chevronLeft', { size: 20 })}</button>
          <button data-pa="rotate" aria-label="${t('Girar')}">${icon('rotate', { size: 19 })}</button>
          <button data-pa="dup" aria-label="${t('Duplicar')}">${icon('copy', { size: 19 })}</button>
          <button data-pa="del" aria-label="${t('Excluir')}" class="danger">${icon('trash', { size: 19 })}</button>
          <button data-pa="right" aria-label="${t('Mover para a direita')}" ${i === doc.pages.length - 1 ? 'disabled' : ''}>${icon('chevronRight', { size: 20 })}</button>
        </div>
      </div>`);
      frag.append(card);
    });
    gridEl.append(frag);
    // Miniaturas em sequência para não travar o aparelho
    for (const card of gridEl.querySelectorAll('.pcard')) {
      const p = pageByKey(card.dataset.key);
      if (!p || !card.isConnected) continue;
      const pg = await pdfPage(p);
      const base = pg.getViewport({ scale: 1, rotation: (pg.rotate + p.rotate) % 360 });
      const w = Math.min(320, card.clientWidth * Math.min(2, window.devicePixelRatio || 1));
      const vp = pg.getViewport({ scale: w / base.width, rotation: (pg.rotate + p.rotate) % 360 });
      const c = $('canvas', card);
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      await pg.render({ canvasContext: c.getContext('2d'), canvas: c, viewport: vp }).promise.catch(() => {});
      // Anotações por cima da miniatura
      if (p.objects.length) {
        const sc = new fabric.StaticCanvas(document.createElement('canvas'), { width: c.width, height: c.height, enableRetinaScaling: false });
        sc.setZoom(c.width / base.width);
        await sc.loadFromJSON({ objects: p.objects });
        sc.renderAll();
        c.getContext('2d').drawImage(sc.getElement(), 0, 0);
        sc.dispose();
      }
    }
  }

  // Girar 90° no sentido horário levando junto as anotações
  async function rotateObjects(objects, vw, vh) {
    if (!objects.length) return objects;
    const live = await fabric.util.enlivenObjects(objects);
    return live.map((o) => {
      o.setCoords();
      const c = o.getCenterPoint();
      o.rotate((o.angle + 90) % 360);
      o.setPositionByOrigin(new fabric.Point(vh - c.y, c.x), 'center', 'center');
      return o.toObject(PROPS);
    });
  }

  gridEl.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pa]');
    if (!b) return;
    const key = b.closest('.pcard').dataset.key;
    const i = doc.pages.findIndex((p) => p.key === key);
    const before = snapshotPages();
    const act = b.dataset.pa;
    if (act === 'del') {
      if (doc.pages.length === 1) return toast(t('O documento precisa ter ao menos uma página.'));
      doc.pages.splice(i, 1);
    } else if (act === 'left' && i > 0) {
      [doc.pages[i - 1], doc.pages[i]] = [doc.pages[i], doc.pages[i - 1]];
    } else if (act === 'right' && i < doc.pages.length - 1) {
      [doc.pages[i + 1], doc.pages[i]] = [doc.pages[i], doc.pages[i + 1]];
    } else if (act === 'dup') {
      const p = doc.pages[i];
      doc.pages.splice(i + 1, 0, { ...p, key: `${p.src}:${p.index}:${Date.now().toString(36)}`, objects: [...p.objects] });
    } else if (act === 'rotate') {
      const p = { ...doc.pages[i] };
      const vp = await viewportOf(p);
      p.objects = await rotateObjects(p.objects, vp.width, vp.height);
      p.rotate = (p.rotate + 90) % 360;
      doc.pages[i] = p;
    } else return;
    commitDoc(before);
    setTitle();
    await renderGrid();
  });

  async function addPages(kind) {
    let bytes;
    if (kind === 'blank') {
      const last = doc.pages[doc.pages.length - 1];
      const vp = await viewportOf({ ...last, rotate: 0 });
      bytes = await blankPdf(vp.width, vp.height);
    } else if (kind === 'pdf') {
      const [file] = await pickFiles({ accept: 'application/pdf' });
      if (!file) return;
      bytes = new Uint8Array(await file.arrayBuffer());
    } else {
      const files = await pickFiles({ accept: 'image/*', multiple: true });
      if (!files.length) return;
      const stop = busy(t('Criando PDF…'));
      try { bytes = await imagesToPdf(files); } finally { stop(); }
    }
    let src;
    try { src = await loadPdf(bytes); } catch (err) {
      return toast(isPasswordError(err) ? t('Este PDF tem senha. Abra-o no computador para remover a senha.') : t('Não foi possível abrir este arquivo.'), 'error');
    }
    const id = `s${srcCounter++}`;
    doc.sources.set(id, { bytes, pdf: src });
    const before = snapshotPages();
    for (let i = 0; i < src.numPages; i++) doc.pages.push({ key: `${id}:${i}`, src: id, index: i, rotate: 0, objects: [] });
    commitDoc(before);
    setTitle();
    await renderGrid();
    gridEl.scrollTo({ top: gridEl.scrollHeight, behavior: 'smooth' });
  }

  // ---------- Modos ----------
  async function setMode(m) {
    state.mode = m;
    root.dataset.mode = m;
    root.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
    const pages = m === 'pages';
    scroller.hidden = pages;
    gridEl.hidden = !pages;
    if (pages) {
      for (const v of views.values()) v.canvas?.discardActiveObject();
      hideSelbar();
      hintEl.hidden = true;
      state.tool = 'select';
      renderTools();
      await renderGrid();
    } else {
      gridEl.innerHTML = '';
      const needLayout = views.size !== doc.pages.length || doc.pages.some((p, i) => pagesEl.children[i]?.dataset.key !== p.key || views.get(p.key)?.rot !== p.rotate);
      if (m === 'forms') {
        await loadForm();
        setTool('fill');
        if (!doc.form.fields.length) toast(t('Este PDF não tem campos. Use "Novo campo" ou "Nova caixa" para criar.'));
      } else setTool(m === 'edit' ? 'edittext' : 'select');
      if (needLayout) await layout(); else refreshFormLayers();
    }
  }

  root.querySelector('.ed-modes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b && b.dataset.mode !== state.mode) setMode(b.dataset.mode);
  });

  // ---------- Zoom com pinça ----------
  let pinch = null;
  scroller.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    const [a, b] = e.touches;
    pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z: state.zoom, s: 1, my: (a.clientY + b.clientY) / 2, sy: scroller.scrollTop };
    pagesEl.style.transformOrigin = `50% ${scroller.scrollTop + pinch.my - scroller.getBoundingClientRect().top}px`;
  }, { passive: true });
  scroller.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const [a, b] = e.touches;
    const s = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d;
    pinch.s = Math.max(1 / pinch.z, Math.min(4 / pinch.z, s));
    pagesEl.style.transform = `scale(${pinch.s})`;
  }, { passive: false });
  scroller.addEventListener('touchend', async () => {
    if (!pinch) return;
    const { z, s, sy } = pinch;
    pinch = null;
    pagesEl.style.transform = '';
    const nz = Math.round(z * s * 100) / 100;
    if (Math.abs(nz - state.zoom) < 0.02) return;
    state.zoom = nz;
    await layout();
    scroller.scrollTop = sy * (nz / z);
  });

  // ---------- Indicador de página ----------
  let indTimer;
  function updatePageInd() {
    const key = visibleKey();
    const i = doc.pages.findIndex((p) => p.key === key);
    pageInd.textContent = `${i + 1} / ${doc.pages.length}`;
    pageInd.hidden = false;
    pageInd.classList.add('show');
    clearTimeout(indTimer);
    indTimer = setTimeout(() => pageInd.classList.remove('show'), 1200);
  }
  scroller.addEventListener('scroll', updatePageInd, { passive: true });

  // ---------- Salvar / sair ----------
  let lastPlain = null; // última versão salva, sem senha (para imprimir)
  async function save() {
    for (const v of views.values()) {
      const obj = v.canvas?.getActiveObject();
      if (obj?.isEditing) obj.exitEditing();
      v.canvas?.discardActiveObject();
    }
    hideSelbar();
    const stop = busy(t('Salvando…'));
    let meta;
    try {
      const plain = await buildPdf(doc);
      const saved = await loadPdf(plain.slice());
      const thumb = await thumbnail(saved);
      // PDF que veio com senha continua com a mesma senha
      lastPlain = plain;
      const bytes = doc.protection ? (await engine('finalize', { bytes: plain, encrypt: { user: doc.protection.password, owner: doc.protection.password } })).bytes : plain;
      meta = await saveDoc({ id: doc.id, name: doc.name, bytes, pages: saved.numPages, thumb });
      saved.loadingTask?.destroy?.();
      doc.id = meta.id;
      state.dirty = false;
    } catch (err) {
      console.error(err);
      stop();
      toast(t('Não foi possível abrir este arquivo.'), 'error');
      return;
    }
    stop();
    const s = sheet(`<div class="saved-ok">${icon('check', { size: 30, stroke: 2.4 })}</div>
      <p class="sheet-text center"><strong>${t('Salvo na sua biblioteca')}</strong><br>${t('Use Compartilhar para mandar por WhatsApp, e-mail ou salvar em outra pasta.')}</p>
      <div class="sheet-actions">
        <button class="btn btn-primary" data-share>${icon('share', { size: 18 })}<span>${t('Compartilhar')}</span></button>
        <button class="btn btn-secondary" data-print>${icon('printer', { size: 18 })}<span>${t('Imprimir')}</span></button>
        <button class="btn btn-secondary" data-ok>${t('OK')}</button>
      </div>`);
    $('[data-print]', s.el).addEventListener('click', async () => { s.close(); try { await printPdf(lastPlain, doc.name); } catch { toast(t('Não foi possível imprimir.'), 'error'); } });
    $('[data-share]', s.el).addEventListener('click', async () => { s.close(); try { await shareDoc(meta); } catch {} });
    $('[data-ok]', s.el).addEventListener('click', () => s.close());
  }

  // Imprime o documento como está na tela (com as alterações ainda não salvas)
  async function printNow() {
    for (const v of views.values()) {
      const obj = v.canvas?.getActiveObject();
      if (obj?.isEditing) obj.exitEditing();
    }
    const stop = busy(t('Preparando a impressão…'));
    let bytes;
    try { bytes = await buildPdf(doc); } catch (err) {
      console.error(err);
      stop();
      return toast(t('Não foi possível imprimir.'), 'error');
    }
    stop();
    try { await printPdf(bytes, doc.name); } catch { toast(t('Não foi possível imprimir.'), 'error'); }
  }

  async function back() {
    if (document.querySelector('.sheet-root')) return;
    if (state.dirty) {
      const discard = await confirmSheet({ title: t('Descartar alterações?'), text: t('Você tem alterações que ainda não foram salvas.'), ok: t('Descartar'), cancel: t('Continuar editando'), danger: true });
      if (!discard) return;
    }
    close();
  }

  function close() {
    stopKeyboardWatch();
    io?.disconnect();
    for (const key of [...views.keys()]) unmount(key);
    for (const s of doc.sources.values()) s.pdf.loadingTask?.destroy?.();
    root.classList.remove('open');
    document.body.classList.remove('editing');
    setTimeout(() => root.remove(), 220);
    current = null;
    onExit?.();
  }

  root.querySelector('.ed-top').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'back') back();
    else if (act === 'save') save();
    else if (act === 'print') printNow();
    else if (act === 'undo') step(state.undo, state.redo, 'before');
    else if (act === 'redo') step(state.redo, state.undo, 'after');
  });

  // ---------- Teclado ----------
  // Com o teclado aberto a tela encolhe: some com as barras de baixo e rola até o texto em edição
  let fullHeight = window.innerHeight;
  function keepVisible() {
    const obj = activeObj();
    const v = selKey && views.get(selKey);
    if (!obj || !v?.canvas) return;
    const zoom = v.canvas.getZoom();
    const pg = v.el.getBoundingClientRect();
    const br = obj.getBoundingRect();
    const top = pg.top + br.top * zoom;
    const bottom = pg.top + (br.top + br.height) * zoom;
    const area = scroller.getBoundingClientRect();
    const covered = selbar.hidden ? 0 : selbar.getBoundingClientRect().height + 20;
    const limit = area.bottom - covered - 16;
    if (bottom > limit) scroller.scrollTop += bottom - limit;
    else if (top < area.top + 12) scroller.scrollTop -= area.top + 12 - top;
    const left = pg.left + br.left * zoom;
    if (left < area.left || left > area.right - 40) scroller.scrollLeft += left - area.left - 24;
  }
  // o teclado abre com animação: confere de novo quando a tela termina de encolher
  const keepVisibleSoon = () => { keepVisible(); setTimeout(keepVisible, 250); setTimeout(keepVisible, 600); };
  const onResize = () => {
    fullHeight = Math.max(fullHeight, window.innerHeight);
    const open = window.innerHeight < fullHeight - 150;
    root.classList.toggle('kbd', open);
    if (open) keepVisibleSoon();
  };
  window.addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('resize', onResize);
  const stopKeyboardWatch = () => { window.removeEventListener('resize', onResize); window.visualViewport?.removeEventListener('resize', onResize); };

  current = { back };
  window.__editor = { doc, views, state }; // ajuda a depurar pelo WebView
  await layout();
  await setMode(state.mode);
  if (mode === 'redact') setTool('redact');
}
