// Tela do editor: páginas com rolagem, ferramentas de anotação/assinatura e o modo de organizar páginas.
import { t, getLang } from './i18n.js';
import { icon } from './icons.js';
import { $, h, esc, sheet, confirmSheet, toast, busy, pickFiles, pagesLabel } from './ui.js';
import { fabric } from './fabric-setup.js';
import { loadPdf, isPasswordError, buildPdf, imagesToPdf, thumbnail } from './pdf.js';
import { saveDoc, shareDoc } from './storage.js';
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
    ['pen', 'pen', 'Caneta'],
    ['cover', 'cover', 'Cobrir'],
    ['image', 'image', 'Imagem'],
  ],
  sign: [
    ['select', 'hand', 'Selecionar'],
    ['sign', 'signature', 'Assinatura'],
    ['text', 'type', 'Texto'],
    ['date', 'calendar', 'Data'],
    ['x', 'x', 'Marcar X'],
  ],
};
const HINTS = {
  text: 'Toque na página para escrever',
  highlight: 'Arraste sobre o texto para marcar',
  pen: 'Desenhe com o dedo',
  cover: 'Arraste para cobrir uma área',
};

let current = null; // há só um editor aberto por vez

export function editorIsOpen() { return !!current; }
export function editorBack() { current?.back(); }

export async function openEditor({ name, id = null, bytes, mode = 'annotate', onExit }) {
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

  const doc = { name, id, sources: new Map([['s0', { bytes, pdf }]]), pages: [] };
  for (let i = 0; i < pdf.numPages; i++) doc.pages.push({ key: `s0:${i}`, src: 's0', index: i, rotate: 0, objects: [] });
  let srcCounter = 1;

  const state = { mode, tool: 'select', zoom: 1, dirty: false, undo: [], redo: [], loading: false };
  const colors = { text: TEXT_COLORS[0], pen: '#1c4a82', hl: HL_COLORS[0] };

  const root = h(`<section class="editor" aria-label="${esc(name)}">
    <header class="ed-top">
      <button class="icon-btn" data-act="back" aria-label="${t('Voltar')}">${icon('back')}</button>
      <div class="ed-title"><strong></strong><small></small></div>
      <button class="icon-btn" data-act="undo" aria-label="${t('Desfazer')}" disabled>${icon('undo')}</button>
      <button class="icon-btn" data-act="redo" aria-label="${t('Refazer')}" disabled>${icon('redo')}</button>
      <button class="btn btn-primary btn-sm" data-act="save">${icon('check', { size: 18, stroke: 2.4 })}<span>${t('Salvar')}</span></button>
    </header>
    <div class="ed-modes" role="tablist">
      <button role="tab" data-mode="annotate">${icon('highlighter', { size: 18 })}<span>${t('Anotar')}</span></button>
      <button role="tab" data-mode="sign">${icon('signature', { size: 18 })}<span>${t('Assinar')}</span></button>
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
      const el = h(`<div class="pg" style="width:${w}px;height:${hgt}px"><canvas class="pg-img"></canvas><div class="pg-fab"></div><span class="pg-num">${doc.pages.indexOf(p) + 1}</span></div>`);
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
    const after = v.canvas.toObject(['kind']).objects;
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
      toolsEl.innerHTML = `<button class="tool wide" data-page-add="pdf">${icon('file')}<span>${t('Adicionar PDF')}</span></button>
        <button class="tool wide" data-page-add="img">${icon('images')}<span>${t('Adicionar imagem')}</span></button>`;
      return;
    }
    toolsEl.innerHTML = MODES[state.mode].map(([id, ic, label]) => `<button class="tool ${state.tool === id ? 'on' : ''}" data-tool="${id}">${icon(ic)}<span>${t(label)}</span></button>`).join('')
      + (['text', 'pen', 'highlight'].includes(state.tool) ? `<button class="tool" data-tool-color aria-label="${t('Cor')}"><span class="dot big" style="--c:${toolColor()}"></span><span>${t('Cor')}</span></button>` : '');
  }

  const toolColor = () => (state.tool === 'pen' ? colors.pen : state.tool === 'highlight' ? colors.hl : colors.text);

  // keep: canvas cujo objeto ativo deve continuar selecionado (ex.: texto recém-criado em edição)
  function setTool(tool, keep = null) {
    state.tool = tool;
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
    c.skipTargetFind = ['highlight', 'cover', 'text'].includes(state.tool);
  }

  function wireCanvas(key, canvas) {
    const v = views.get(key);
    canvas.on('object:added', (e) => { if (!state.loading && !e.target?._creating) commit(key); });
    canvas.on('object:modified', () => commit(key));
    canvas.on('object:removed', () => { if (!state.loading) commit(key); });
    canvas.on('text:editing:exited', (e) => {
      const obj = e.target;
      if (obj && !obj.text.trim()) canvas.remove(obj); else commit(key);
    });
    canvas.on('selection:created', () => { showSelbar(key); applyToolTo(v); });
    canvas.on('selection:updated', () => showSelbar(key));
    canvas.on('selection:cleared', () => { hideSelbar(); applyToolTo(v); });

    let drag = null;
    canvas.on('mouse:down', (e) => {
      const pt = canvas.getScenePoint(e.e);
      if (state.tool === 'text') {
        const obj = new fabric.IText('', { left: pt.x, top: pt.y - 8, fontFamily: FONT, fontSize: 14, fill: colors.text, kind: 'text', editingBorderColor: '#c8141c', cursorColor: '#c8141c' });
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
      if (state.tool === 'highlight' || state.tool === 'cover') {
        const isHl = state.tool === 'highlight';
        const rect = new fabric.Rect({
          left: pt.x, top: pt.y, width: 1, height: 1,
          fill: isHl ? colors.hl : '#ffffff', opacity: isHl ? 0.42 : 1, strokeWidth: 0,
          kind: state.tool, selectable: true,
        });
        rect._creating = true;
        canvas.add(rect);
        drag = { rect, x: pt.x, y: pt.y };
      }
    });
    canvas.on('mouse:move', (e) => {
      if (!drag) return;
      const pt = canvas.getScenePoint(e.e);
      drag.rect.set({ left: Math.min(pt.x, drag.x), top: Math.min(pt.y, drag.y), width: Math.abs(pt.x - drag.x), height: Math.abs(pt.y - drag.y) });
      canvas.requestRenderAll();
    });
    canvas.on('mouse:up', () => {
      if (!drag) return;
      const { rect } = drag;
      const drag0 = drag;
      drag = null;
      rect._creating = false;
      if (rect.kind === 'highlight') {
        // Arrastar na horizontal (o gesto natural) marca uma linha inteira de texto
        if (rect.height < 11) rect.set({ height: 13, top: drag0.y - 6.5 });
        if (rect.width < 4) rect.set({ width: 120 });
      } else if (rect.width < 4 || rect.height < 3) {
        state.loading = true; canvas.remove(rect); state.loading = false; return;
      }
      rect.setCoords();
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
    const col = obj.kind === 'pen' ? obj.stroke : obj.fill;
    $('[data-sel="color"]', selbar).hidden = obj.kind === 'cover' || obj.type === 'image';
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
      const copy = await obj.clone(['kind']);
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
      if (obj.kind === 'pen') obj.set({ stroke: col }); else obj.set({ fill: col });
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
      if (state.tool === 'pen') colors.pen = col; else if (state.tool === 'highlight') colors.hl = col; else colors.text = col;
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
      return o.toObject(['kind']);
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
    if (kind === 'pdf') {
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
      setTool('select');
      if (needLayout) await layout();
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
      const bytes = await buildPdf(doc);
      const saved = await loadPdf(bytes);
      const thumb = await thumbnail(saved);
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
        <button class="btn btn-secondary" data-ok>${t('OK')}</button>
      </div>`);
    $('[data-share]', s.el).addEventListener('click', async () => { s.close(); try { await shareDoc(meta); } catch {} });
    $('[data-ok]', s.el).addEventListener('click', () => s.close());
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
    else if (act === 'undo') step(state.undo, state.redo, 'before');
    else if (act === 'redo') step(state.redo, state.undo, 'after');
  });

  current = { back };
  window.__editor = { doc, views, state }; // ajuda a depurar pelo WebView
  await layout();
  await setMode(mode);
}
