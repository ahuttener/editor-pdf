// Funções de "programa completo": páginas, documento, conversões, proteção, comentários,
// carimbos, busca, marcadores, impressão e arquivos recentes.
import { newUid } from './libs.js';
import {
  formDialog, confirmDialog, choiceDialog, passwordDialog, watermarkDialog, headerFooterDialog, propertiesDialog,
  compressDialog, splitDialog, imagesExportDialog, ocrDialog, aboutDialog,
} from './dialogs.js';
import { signatureDialog } from './signature.js';
import { loadTextRuns } from './textedit.js';
import { permissionsFrom } from './save.js';
import { t, getLang } from './i18n.js';

const $ = (sel) => document.querySelector(sel);
const LOGO_KEY = 'editorpdf.meulogo';

export function setupFeatures(ctx) {
  const { state, api, fabric, toast, busy } = ctx;

  const requireDoc = () => {
    if (!ctx.hasDoc()) { toast('Abra um PDF primeiro.'); return false; }
    return true;
  };

  // Executa uma ação com indicador de "ocupado" e mensagem de erro amigável
  async function task(label, fn) {
    return ctx.exclusive(async () => {
      busy(label);
      try { return await fn(); } catch (err) {
        console.error(err);
        toast(t('Não deu certo: {erro}', { erro: err?.message || err }), true);
        return null;
      } finally { busy(false); }
    });
  }

  const today = () => new Date().toLocaleDateString(getLang() === 'en' ? 'en-GB' : 'pt-BR');
  const pageNumberOf = (entry) => state.pages.indexOf(entry) + 1;

  // ---------- notas (comentários) ----------

  function addNote(entry, point, text = '') {
    const note = new fabric.Textbox(text || t('Comentário'), {
      left: point.x, top: point.y, width: 180, fontSize: 11, fontFamily: 'Arial',
      fill: '#3b3000', backgroundColor: '#fff59d', padding: 6, kind: 'note', uid: newUid(),
      shadow: new fabric.Shadow({ color: 'rgba(0,0,0,.18)', blur: 6, offsetX: 1, offsetY: 2 }),
    });
    ctx.addObjects(entry, [note]);
    if (!text) { note.enterEditing(); note.selectAll(); }
    return note;
  }

  function refreshComments() {
    const box = $('#comments');
    box.replaceChildren();
    const notes = [];
    for (const entry of state.pages) {
      for (const o of entry.plainObjects()) if (o.kind === 'note') notes.push({ entry, o });
    }
    if (!notes.length) {
      const p = document.createElement('p');
      p.className = 'side-empty';
      p.textContent = t('Nenhum comentário. Use Comentar → Nota.');
      box.append(p);
      return;
    }
    for (const { entry, o } of notes) {
      const b = document.createElement('button');
      b.className = 'comment';
      b.textContent = String(o.text || '').slice(0, 120);
      const small = document.createElement('small');
      small.textContent = t('Página {n}', { n: pageNumberOf(entry) });
      b.append(small);
      b.onclick = async () => {
        entry.el.scrollIntoView({ block: 'center' });
        const canvas = await ctx.materialize(entry);
        const target = canvas.getObjects().find((x) => x.uid === o.uid);
        if (target) { canvas.setActiveObject(target); canvas.requestRenderAll(); }
      };
      box.append(b);
    }
  }

  // ---------- carimbos ----------

  const STAMP_COLORS = { APROVADO: '#2e7d32', PAGO: '#2e7d32', RECEBIDO: '#1565c0', REPROVADO: '#c62828', CONFIDENCIAL: '#c62828', RASCUNHO: '#6d4c41', 'CÓPIA': '#455a64' };

  function loadLogo() { try { return localStorage.getItem(LOGO_KEY); } catch { return null; } }
  function storeLogo(dataUrl) { try { localStorage.setItem(LOGO_KEY, dataUrl); } catch { /* sem espaço: usa só agora */ } }

  async function pickLogo() {
    const [file] = await api.pickFiles('image');
    if (!file) return null;
    const { dataUrl } = await ctx.toEmbeddableImage(file.data, file.mime);
    // reduz para no máximo 900 px, para caber no armazenamento local
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const s = Math.min(1, 900 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * s);
    c.height = Math.round(img.height * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const small = c.toDataURL('image/png');
    storeLogo(small);
    return small;
  }

  async function placeStamp(entry, point) {
    const value = state.pendingStamp;
    state.pendingStamp = null;
    $('#stamp-select').value = '';
    if (!value) return;
    if (value === '@logo') {
      const logo = loadLogo() || await pickLogo();
      if (logo) await ctx.addImage(entry, logo, 'stamp', 0.25, point);
      return;
    }
    const EN_STAMPS = { APROVADO: 'APPROVED', REPROVADO: 'REJECTED', PAGO: 'PAID', RECEBIDO: 'RECEIVED', CONFIDENCIAL: 'CONFIDENTIAL', RASCUNHO: 'DRAFT', 'CÓPIA': 'COPY' };
    const text = value === '@data' ? t('RECEBIDO EM {data}', { data: today() }) : (getLang() === 'en' ? EN_STAMPS[value] || value : value);
    const color = STAMP_COLORS[value] || '#1565c0';
    const label = new fabric.FabricText(text, { fontFamily: 'Arial', fontWeight: 'bold', fontSize: 22, fill: color, charSpacing: 80, originX: 'center', originY: 'center' });
    const box = new fabric.Rect({
      width: label.width + 28, height: label.height + 14, rx: 6, ry: 6, fill: 'rgba(255,255,255,0.01)',
      stroke: color, strokeWidth: 3, originX: 'center', originY: 'center',
    });
    const group = new fabric.Group([box, label], { kind: 'stamp', uid: newUid(), angle: -8, opacity: 0.9 });
    group.setPositionByOrigin(point, 'center', 'center');
    ctx.addObjects(entry, [group]);
  }

  // ---------- marca d'água / cabeçalho e rodapé ----------

  async function watermark() {
    if (!requireDoc()) return;
    const fonts = state.fonts.filter((f) => !f.script).map((f) => f.family);
    const v = await watermarkDialog({ ...(state.lastWatermark || {}), fonts });
    if (!v) return;
    let logo = null;
    if (v.useLogo && !v.remove) {
      logo = loadLogo() || await pickLogo();
      if (!logo) return;
    }
    state.lastWatermark = v;
    for (const entry of state.pages) {
      await ctx.materialize(entry);
      const old = entry.fabric.getObjects().filter((o) => o.kind === 'watermark');
      state.suspend++;
      entry.fabric.remove(...old);
      state.suspend--;
      if (v.remove) { ctx.pushHistory(entry); continue; }
      const vp = entry.viewport();
      const center = new fabric.Point(vp.width / 2, vp.height / 2);
      let obj;
      if (logo) {
        obj = await fabric.FabricImage.fromURL(logo);
        const s = (vp.width * 0.5) / obj.width;
        obj.set({ scaleX: s, scaleY: s });
      } else {
        obj = new fabric.IText(v.text || 'CONFIDENCIAL', { fontFamily: v.font, fontSize: v.size, fontWeight: 'bold', fill: v.color });
      }
      obj.set({ kind: 'watermark', uid: newUid(), opacity: (v.opacity || 18) / 100, angle: v.angle || 0 });
      obj.setPositionByOrigin(center, 'center', 'center');
      state.suspend++;
      entry.fabric.insertAt(0, obj);
      state.suspend--;
      entry.fabric.requestRenderAll();
      ctx.pushHistory(entry);
    }
    ctx.trimMemory();
    toast(v.remove ? "Marca d'água removida." : "Marca d'água aplicada em todas as páginas.");
  }

  const SLOTS = ['tl', 'tc', 'tr', 'bl', 'bc', 'br'];

  function fillTemplate(tpl, entry) {
    const cfg = state.hf || {};
    const n = (cfg.start ?? 1) + state.pages.indexOf(entry);
    return tpl
      .replaceAll('{n}', String(n))
      .replaceAll('{total}', String(state.pages.length + (cfg.start ?? 1) - 1))
      .replaceAll('{data}', today())
      .replaceAll('{arquivo}', ctx.baseName());
  }

  function placeHeaderFooter(entry) {
    const cfg = state.hf;
    const old = entry.fabric.getObjects().filter((o) => o.kind === 'hf');
    state.suspend++;
    entry.fabric.remove(...old);
    state.suspend--;
    if (!cfg || cfg.remove || (cfg.skipFirst && state.pages.indexOf(entry) === 0)) return;
    const vp = entry.viewport();
    const m = cfg.margin || 22;
    for (const slot of SLOTS) {
      const tpl = cfg[slot];
      if (!tpl) continue;
      const t = new fabric.IText(fillTemplate(tpl, entry), {
        fontFamily: 'Arial', fontSize: cfg.size || 9, fill: cfg.color || '#444444', kind: 'hf', tpl: `${slot}|${tpl}`, uid: newUid(),
        textAlign: slot[1] === 'l' ? 'left' : slot[1] === 'c' ? 'center' : 'right',
      });
      const x = slot[1] === 'l' ? m : slot[1] === 'c' ? (vp.width - t.width) / 2 : vp.width - m - t.width;
      const y = slot[0] === 't' ? m : vp.height - m - t.height;
      t.set({ left: x, top: y });
      state.suspend++;
      entry.fabric.add(t);
      state.suspend--;
    }
    entry.fabric.requestRenderAll();
  }

  // Recoloca cabeçalho/rodapé (números de página mudam ao mover/excluir páginas).
  // Páginas sem camada montada ficam marcadas e são atualizadas quando montadas ou ao salvar.
  function refreshHeaderFooter(only) {
    if (!state.hf) return;
    for (const entry of only ? [only] : state.pages) {
      if (!entry.fabric) { entry.hfStale = true; continue; }
      entry.hfStale = false;
      placeHeaderFooter(entry);
      if (!only) entry.lastJson = ctx.snapshot(entry);
    }
  }

  async function headerFooter(defaults) {
    if (!requireDoc()) return;
    const v = await headerFooterDialog({ ...(state.hf || {}), ...defaults });
    if (!v) return;
    state.hf = v.remove ? null : v;
    for (const entry of state.pages) {
      await ctx.materialize(entry);
      entry.hfStale = false;
      if (v.remove) {
        state.suspend++;
        entry.fabric.remove(...entry.fabric.getObjects().filter((o) => o.kind === 'hf'));
        state.suspend--;
        entry.fabric.requestRenderAll();
      } else {
        placeHeaderFooter(entry);
      }
      ctx.pushHistory(entry);
    }
    ctx.trimMemory();
    ctx.setDirty(true);
    toast(v.remove ? 'Cabeçalho e rodapé removidos.' : 'Cabeçalho e rodapé aplicados.');
  }

  // ---------- documento ----------

  async function properties() {
    if (!requireDoc()) return;
    const v = await propertiesDialog(state.meta);
    if (!v) return;
    state.meta = v;
    ctx.setDirty(true);
    toast('Propriedades serão gravadas ao salvar.');
  }

  async function compress() {
    if (!requireDoc()) return;
    const bytes = await task('Preparando…', () => ctx.buildFinal({ encrypt: false }));
    if (!bytes) return;
    const v = await compressDialog(ctx.formatBytes(bytes.length));
    if (!v) return;
    await task('Comprimindo…', async () => {
      let out = (await api.engine('compress', { bytes, level: v.level })).bytes;
      const p = state.protection;
      if (p) out = (await api.engine('finalize', { bytes: out, encrypt: { user: p.user, owner: p.owner, permissions: p.permissions ?? permissionsFrom(p) } })).bytes;
      const result = await api.savePdf(out, { saveAs: true, title: t('Salvar PDF comprimido'), suggestedPath: ctx.suggestedPath(' (comprimido)'), selftestName: state.selftest ? 'comprimido.pdf' : undefined });
      if (!result) return;
      const pct = Math.round((1 - out.length / bytes.length) * 100);
      toast(`${ctx.formatBytes(bytes.length)} → ${ctx.formatBytes(out.length)} (${pct > 0 ? `−${pct}%` : t('já estava otimizado')})`, false, { label: 'Mostrar na pasta', run: () => api.showInFolder(result.path) });
      state.lastCompress = { before: bytes.length, after: out.length };
    });
  }

  async function ocr(preset) {
    if (!requireDoc()) return;
    const v = preset || await ocrDialog(state.pages.length);
    if (!v) return;
    const pages = v.which === 'selected' ? ctx.targetPages() : state.pages;
    const byDoc = new Map();
    for (const p of pages) {
      if (!byDoc.has(p.docKey)) byDoc.set(p.docKey, new Set());
      byDoc.get(p.docKey).add(p.index);
    }
    return task('Reconhecendo texto…', async () => {
      let total = 0;
      let words = 0;
      for (const [docKey, indices] of byDoc) {
        const r = await api.engine('ocr', { bytes: state.docs.get(docKey).bytes, pages: [...indices], force: !!v.force });
        if (r.pages) {
          await ctx.replaceDocBytes(docKey, r.bytes);
          total += r.pages;
          words += r.words;
        }
      }
      if (total) {
        ctx.setDirty(true);
        if (state.tool === 'edittext') for (const p of state.pages) ctx.ensureRuns(p);
        toast(t('Texto reconhecido em {n} página(s) ({p} palavras). Agora dá para buscar, copiar e usar "Editar texto".', { n: total, p: words }));
      } else {
        toast('As páginas já tinham texto. Marque "Ler também páginas que já têm texto" para forçar.');
      }
      return { total, words };
    });
  }

  // ---------- páginas ----------

  async function extractPages() {
    if (!requireDoc()) return;
    const chosen = ctx.targetPages();
    const indices = chosen.map((p) => state.pages.indexOf(p)).sort((a, b) => a - b);
    return task('Extraindo páginas…', async () => {
      const full = await ctx.buildFinal({ encrypt: false });
      const src = await ctx.PDFLib.PDFDocument.load(full);
      const out = await ctx.PDFLib.PDFDocument.create();
      for (const p of await out.copyPages(src, indices)) out.addPage(p);
      const label = indices.length === 1 ? t('página {n}', { n: indices[0] + 1 }) : t('páginas {lista}', { lista: indices.map((i) => i + 1).join(', ') });
      const result = await api.savePdf(await out.save(), { saveAs: true, title: t('Salvar páginas extraídas'), suggestedPath: ctx.suggestedPath(` (${label})`), selftestName: state.selftest ? 'extraidas.pdf' : undefined });
      if (result) toast(t('{n} página(s) salvas em {nome}.', { n: indices.length, nome: result.name }), false, { label: 'Mostrar na pasta', run: () => api.showInFolder(result.path) });
      return result;
    });
  }

  function parseRanges(text, total) {
    const groups = [];
    for (const part of String(text || '').split(/[,;]+/)) {
      const m = part.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
      if (!m) continue;
      const a = Math.max(1, Math.min(total, Number(m[1])));
      const b = Math.max(1, Math.min(total, Number(m[2] || m[1])));
      const g = [];
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) g.push(i - 1);
      if (g.length) groups.push(g);
    }
    return groups;
  }

  async function splitPdf(preset) {
    if (!requireDoc()) return;
    const total = state.pages.length;
    const v = preset || await splitDialog(total);
    if (!v) return;
    let groups = [];
    if (v.mode === 'each') groups = [...Array(total).keys()].map((i) => [i]);
    else if (v.mode === 'every') { const n = Math.max(1, v.every || 1); for (let i = 0; i < total; i += n) groups.push([...Array(Math.min(n, total - i)).keys()].map((k) => i + k)); }
    else groups = parseRanges(v.ranges, total);
    if (!groups.length) { toast('Nenhum intervalo válido.', true); return; }
    const dir = await api.pickDir(t('Escolha a pasta para os PDFs divididos'));
    if (!dir) return;
    return task('Dividindo…', async () => {
      const full = await ctx.buildFinal({ encrypt: false });
      const src = await ctx.PDFLib.PDFDocument.load(full);
      const files = [];
      for (const [i, g] of groups.entries()) {
        const out = await ctx.PDFLib.PDFDocument.create();
        for (const p of await out.copyPages(src, g)) out.addPage(p);
        const range = g.length > 1 ? `${g[0] + 1}-${g[g.length - 1] + 1}` : `${g[0] + 1}`;
        files.push({ name: t('{base} (parte {i} - pág {faixa}).pdf', { base: ctx.baseName(), i: i + 1, faixa: range }), data: await out.save() });
      }
      const written = await api.writeToDir(dir, files);
      toast(t('{n} arquivo(s) criados.', { n: written.length }), false, { label: 'Mostrar na pasta', run: () => api.showInFolder(written[0]) });
      return written;
    });
  }

  // ---------- converter ----------

  async function toWord() {
    if (!requireDoc()) return;
    return task('Convertendo para Word…', async () => {
      const full = await ctx.buildFinal({ encrypt: false });
      const { bytes } = await api.engine('toDocx', { bytes: full, title: state.meta.title || ctx.baseName() });
      const result = await api.saveFileAs(bytes, { ext: 'docx', filterName: t('Documento do Word'), title: t('Salvar como Word'), suggestedPath: ctx.suggestedPath('', 'docx'), selftestName: state.selftest ? 'convertido.docx' : undefined });
      if (result) toast(t('Word salvo: {nome}', { nome: result.name }), false, { label: 'Mostrar na pasta', run: () => api.showInFolder(result.path) });
      return result;
    });
  }

  async function toImages(preset) {
    if (!requireDoc()) return;
    const v = preset || await imagesExportDialog();
    if (!v) return;
    const indices = v.which === 'selected' ? ctx.targetPages().map((p) => state.pages.indexOf(p)) : [...state.pages.keys()];
    const dir = await api.pickDir(t('Escolha a pasta para as imagens'));
    if (!dir) return;
    return task('Gerando imagens…', async () => {
      const full = await ctx.buildFinal({ encrypt: false });
      const { images } = await api.engine('renderPages', { bytes: full, dpi: Number(v.dpi) || 150, format: v.format, pages: indices });
      const pad = String(state.pages.length).length;
      const files = images.map((data, k) => ({ name: t('{base} - página {n}.{ext}', { base: ctx.baseName(), n: String(indices[k] + 1).padStart(pad, '0'), ext: v.format }), data }));
      const written = await api.writeToDir(dir, files);
      toast(t('{n} imagem(ns) salvas.', { n: written.length }), false, { label: 'Mostrar na pasta', run: () => api.showInFolder(written[0]) });
      return written;
    });
  }

  async function toText() {
    if (!requireDoc()) return;
    return task('Extraindo texto…', async () => {
      const full = await ctx.buildFinal({ encrypt: false });
      const { pages } = await api.engine('structuredText', { bytes: full });
      const text = pages.map((p, i) => `${t('--- Página {n} ---', { n: i + 1 })}\r\n${p.text.replace(/\r?\n/g, '\r\n').trim()}\r\n`).join('\r\n');
      const data = new TextEncoder().encode('﻿' + text);
      const result = await api.saveFileAs(data, { ext: 'txt', filterName: t('Texto'), title: t('Salvar texto'), suggestedPath: ctx.suggestedPath('', 'txt'), selftestName: state.selftest ? 'texto.txt' : undefined });
      if (result) toast(t('Texto salvo: {nome}', { nome: result.name }), false, { label: 'Mostrar na pasta', run: () => api.showInFolder(result.path) });
      return result;
    });
  }

  async function imagesToPdf() {
    const files = (await api.pickFiles('images')).filter((f) => /^image\//.test(f.mime));
    if (!files.length) return;
    if (!ctx.hasDoc()) { await ctx.openFiles(files); return; }
    const choice = await choiceDialog('Imagens → PDF', 'Adicionar as imagens como páginas no final do documento aberto?', 'Adicionar ao documento', 'Criar PDF novo');
    if (choice === 'ok') await ctx.insertDocs(files);
    else if (choice === 'alt') await ctx.openFiles(files); // pergunta antes de descartar alterações
  }

  // ---------- imprimir ----------

  async function print() {
    if (!requireDoc()) return;
    const area = $('#print-area');
    const ok = await task('Preparando a impressão…', async () => {
      const full = await ctx.buildFinal({ encrypt: false });
      const { images } = await api.engine('renderPages', { bytes: full, dpi: 200, format: 'jpg' });
      area.replaceChildren();
      for (const data of images) {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(new Blob([data], { type: 'image/jpeg' }));
        area.append(img);
      }
      await Promise.all([...area.querySelectorAll('img')].map((i) => i.decode().catch(() => {})));
      return true;
    });
    if (!ok) return;
    await api.print();
    for (const img of area.querySelectorAll('img')) URL.revokeObjectURL(img.src);
    area.replaceChildren();
  }

  // ---------- proteger ----------

  async function password() {
    if (!requireDoc()) return;
    const v = await passwordDialog(state.protection);
    if (!v) return;
    state.protection = { user: v.user, owner: v.owner, noPrint: v.noPrint, noCopy: v.noCopy, noEdit: v.noEdit, permissions: permissionsFrom(v) };
    ctx.setDirty(true);
    ctx.updateButtons();
    toast('A senha será aplicada quando você salvar.');
  }

  async function removePassword() {
    if (!requireDoc()) return;
    if (!state.protection) { toast('Este documento não tem senha.'); return; }
    if (!await confirmDialog('Remover senha', 'O PDF será salvo sem senha e sem restrições. Continuar?', 'Remover')) return;
    state.protection = null;
    ctx.setDirty(true);
    ctx.updateButtons();
    toast('Ao salvar, o PDF ficará sem senha.');
  }

  // ---------- busca ----------

  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  let searchHits = [];
  let searchIndex = -1;
  let searchTimer = null;
  let searchToken = 0;

  function openSearch() {
    $('#searchbar').hidden = false;
    const input = $('#search-input');
    input.focus();
    input.select();
  }

  function closeSearch() {
    if ($('#searchbar').hidden) return;
    $('#searchbar').hidden = true;
    clearSearch();
  }

  function clearSearch() {
    searchHits = [];
    searchIndex = -1;
    $('#search-count').textContent = '';
    for (const p of state.pages) p.searchLayer?.replaceChildren();
  }

  async function runSearch(query) {
    const token = ++searchToken; // uma busca nova cancela a anterior
    clearSearch();
    const q = norm(query.trim());
    if (q.length < 2) return 0;
    for (const entry of state.pages) {
      const key = `${entry.rotation()}|${entry.proxyVersion || 0}`;
      if (entry.searchKey !== key) {
        entry.searchRuns = await loadTextRuns(entry, { includeRotated: true }).catch(() => []);
        entry.searchKey = key;
      }
      if (token !== searchToken) return 0;
      for (const run of entry.searchRuns) {
        const hay = norm(run.str);
        let at = hay.indexOf(q);
        while (at >= 0) {
          searchHits.push({ entry, run, start: at, len: q.length });
          at = hay.indexOf(q, at + q.length);
        }
      }
    }
    for (const p of state.pages) renderSearch(p);
    $('#search-count').textContent = searchHits.length ? t('{n} resultado(s)', { n: searchHits.length }) : t('Nada encontrado');
    if (searchHits.length) gotoHit(0);
    return searchHits.length;
  }

  function renderSearch(entry) {
    if (!entry.searchLayer) return;
    entry.searchLayer.replaceChildren();
    const z = state.zoom;
    searchHits.forEach((h, i) => {
      if (h.entry !== entry) return;
      const el = document.createElement('div');
      el.className = 'search-hit' + (i === searchIndex ? ' current' : '');
      if (h.run.vertical) {
        // texto girado: marca o pedaço inteiro
        Object.assign(el.style, { left: `${h.run.left * z}px`, top: `${h.run.top * z}px`, width: `${h.run.width * z}px`, height: `${(h.run.bottom - h.run.top) * z}px` });
      } else {
        const per = h.run.width / Math.max(1, h.run.str.length);
        Object.assign(el.style, {
          left: `${(h.run.left + per * h.start) * z}px`,
          top: `${h.run.top * z}px`,
          width: `${per * h.len * z}px`,
          height: `${(h.run.bottom - h.run.top) * z}px`,
        });
      }
      entry.searchLayer.append(el);
    });
  }

  function gotoHit(i) {
    if (!searchHits.length) return;
    searchIndex = (i + searchHits.length) % searchHits.length;
    const hit = searchHits[searchIndex];
    for (const p of state.pages) renderSearch(p);
    hit.entry.searchLayer.querySelector('.current')?.scrollIntoView({ block: 'center' });
    ctx.setCurrent(hit.entry);
    $('#search-count').textContent = t('{i} de {n}', { i: searchIndex + 1, n: searchHits.length });
  }

  $('#btn-search').addEventListener('click', openSearch);
  $('#search-close').addEventListener('click', closeSearch);
  $('#search-next').addEventListener('click', () => gotoHit(searchIndex + 1));
  $('#search-prev').addEventListener('click', () => gotoHit(searchIndex - 1));
  $('#search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(e.target.value), 250);
  });
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); gotoHit(searchIndex + (e.shiftKey ? -1 : 1)); }
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
  });

  // ---------- marcadores ----------

  async function loadOutline() {
    const box = $('#outline');
    box.replaceChildren();
    const main = state.docs.get('main');
    let outline = null;
    try { outline = await main?.pdf.getOutline(); } catch { outline = null; }
    if (!outline?.length) {
      const p = document.createElement('p');
      p.className = 'side-empty';
      p.textContent = t('Este PDF não tem marcadores.');
      box.append(p);
      return;
    }
    const build = (items) => {
      const ul = document.createElement('ul');
      for (const item of items) {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.textContent = item.title || t('(sem título)');
        b.onclick = async () => {
          try {
            const dest = typeof item.dest === 'string' ? await main.pdf.getDestination(item.dest) : item.dest;
            if (!dest) return;
            const index = typeof dest[0] === 'number' ? dest[0] : await main.pdf.getPageIndex(dest[0]);
            const entry = state.pages.find((p) => p.docKey === 'main' && p.index === index);
            if (entry) { entry.el.scrollIntoView({ block: 'start' }); ctx.setCurrent(entry); }
          } catch (err) { console.warn(err); }
        };
        li.append(b);
        if (item.items?.length) li.append(build(item.items));
        ul.append(li);
      }
      return ul;
    };
    box.append(build(outline));
  }

  // ---------- recentes ----------

  async function loadRecent() {
    const list = await api.recentList();
    $('#recent').hidden = !list.length;
    const ul = $('#recent-list');
    ul.replaceChildren();
    for (const r of list) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.textContent = r.name;
      const small = document.createElement('small');
      small.textContent = r.path;
      b.append(small);
      b.onclick = async () => { const f = await api.recentOpen(r.path); if (f) ctx.openFiles([f]); else loadRecent(); };
      li.append(b);
      ul.append(li);
    }
  }
  $('#recent-clear').addEventListener('click', async () => { await api.recentClear(); loadRecent(); });

  // ---------- carimbo pela lista ----------

  $('#stamp-select').addEventListener('change', async (e) => {
    const value = e.target.value;
    if (!value) return;
    if (!requireDoc()) { e.target.value = ''; return; }
    if (value === '@logo' && !loadLogo()) {
      const logo = await pickLogo();
      if (!logo) { e.target.value = ''; return; }
    }
    ctx.setTool('stamp');
    state.pendingStamp = value;
    $('#stamp-select').value = value;
  });

  // ---------- assinatura e imagem ----------

  async function signature() {
    if (!requireDoc()) return;
    const scripts = state.fonts.filter((f) => f.script).map((f) => f.family);
    const dataUrl = await signatureDialog(scripts);
    if (!dataUrl) return;
    ctx.setTool('select');
    await ctx.addImage(state.current || state.pages[0], dataUrl, 'signature', 0.3);
  }

  async function image() {
    if (!requireDoc()) return;
    const [file] = await api.pickFiles('image');
    if (!file) return;
    ctx.setTool('select');
    await ctx.addImageFile(state.current || state.pages[0], file);
  }

  // ---------- despacho dos botões ----------

  const actions = {
    image, signature,
    insertPdf: async () => { if (requireDoc()) await ctx.insertDocs(await api.pickFiles('any')); },
    blankPage: async () => { if (requireDoc()) await ctx.insertBlankPage(); },
    duplicatePage: async () => { if (requireDoc()) await ctx.duplicatePages(ctx.targetPages()); },
    rotateLeft: () => { if (requireDoc()) for (const p of ctx.targetPages()) ctx.rotatePage(p, -1); },
    rotateRight: () => { if (requireDoc()) for (const p of ctx.targetPages()) ctx.rotatePage(p, 1); },
    deletePages: async () => {
      if (!requireDoc()) return;
      const pages = ctx.targetPages();
      if (pages.length > 1 && !await confirmDialog('Excluir páginas', t('Excluir {n} páginas?', { n: pages.length }), 'Excluir')) return;
      ctx.deletePages(pages);
    },
    extractPages, splitPdf,
    watermark,
    headerFooter: () => headerFooter({}),
    pageNumbers: () => headerFooter({ bc: t('Página {n} de {total}') }),
    ocr, compress, properties,
    toWord, toImages, toText, imagesToPdf,
    password, removePassword,
    print,
    about: () => aboutDialog('1.0.0'),
  };

  $('#btn-print').addEventListener('click', () => run('print'));
  $('#btn-about').addEventListener('click', () => run('about'));

  function run(name) {
    const fn = actions[name];
    if (!fn) { console.warn('ação desconhecida', name); return null; }
    return fn();
  }

  return {
    run, actions, addNote, placeStamp, refreshComments, refreshHeaderFooter,
    openSearch, closeSearch, clearSearch, runSearch, renderSearch, loadOutline, loadRecent,
    gotoHit, parseRanges, ocr, splitPdf, toImages, formDialog,
  };
}
