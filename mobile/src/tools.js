// Ferramentas de documento inteiro (aba Ferramentas): comprimir, OCR, converter, proteger, dividir,
// marca d'água, numeração, cabeçalho/rodapé, propriedades e comparar. O trabalho pesado roda no motor
// (engine/ops.mjs, o mesmo do desktop) num Web Worker; o resto usa pdf-lib aqui mesmo.
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb, degrees, pushGraphicsState, popGraphicsState, concatTransformationMatrix } from 'pdf-lib';
import { t, getLang } from './i18n.js';
import { $, esc, sheet, toast, busy, pickFiles, formSheet, formatSize, confirmSheet } from './ui.js';
import { icon } from './icons.js';
import { listDocs, readDoc, saveDoc, shareFiles, printPdf } from './storage.js';
import { engine } from './engine.js';
import { loadPdf, thumbnail } from './pdf.js';

let ctx = { openMeta: async () => {}, refresh: () => {} };
export function setupTools(c) { ctx = c; }

const baseName = (name) => String(name || 'documento').replace(/\.pdf$/i, '');
const progressText = (p) => t(p.message, p.vars);

// Roda uma tarefa com o painel "carregando"; erros viram aviso. Devolve o resultado ou undefined.
async function task(label, fn) {
  const stop = busy(t(label));
  try {
    return await fn((p) => stop.update(progressText(p)));
  } catch (err) {
    console.error(err);
    toast(err?.message ? `${t('Não foi possível concluir.')} ${err.message}` : t('Não foi possível concluir.'), 'error');
    return undefined;
  } finally {
    stop();
  }
}

// ---------- abrir PDF (biblioteca ou aparelho), já sem senha ----------

function libraryPick(title) {
  const docs = listDocs();
  return new Promise((resolve) => {
    const s = sheet(`<ul class="pick-list">${docs.map((d) => `<li><button data-id="${esc(d.id)}">${d.thumb ? `<img src="${d.thumb}" alt="">` : `<span class="row-ic">${icon('file')}</span>`}<span><strong>${esc(d.name)}</strong><small>${esc(formatSize(d.size))}</small></span></button></li>`).join('')}</ul>
      <div class="sheet-actions"><button class="btn btn-secondary" data-device>${icon('folder', { size: 20 })} ${esc(t('Escolher do aparelho'))}</button></div>`,
    { title, onClose: (v) => resolve(v ?? null) });
    s.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-id],[data-device]');
      if (!b) return;
      s.close(b.dataset.id ? docs.find((d) => d.id === b.dataset.id) : 'device');
    });
  });
}

const ENCRYPT = [...'/Encrypt'].map((c) => c.charCodeAt(0));
function hasEncrypt(bytes) {
  const first = ENCRYPT[0];
  outer: for (let i = bytes.indexOf(first); i >= 0 && i <= bytes.length - ENCRYPT.length; i = bytes.indexOf(first, i + 1)) {
    for (let k = 1; k < ENCRYPT.length; k++) if (bytes[i + k] !== ENCRYPT[k]) continue outer;
    return true;
  }
  return false;
}

// Pede a senha até acertar (ou desistir). Devolve os bytes sem criptografia ou null.
export async function ensureUnlocked(bytes, name = '') {
  if (!hasEncrypt(bytes)) return bytes; // sem /Encrypt não há senha: nem carrega o motor
  let info;
  try { info = await engine('inspect', { bytes: bytes.slice() }); } catch { return bytes; } // o pdf.js dirá se não abre
  if (!info.encrypted) return bytes;
  if (!info.needsPassword && info.canEdit) {
    const r = await engine('unlock', { bytes: bytes.slice(), password: '' });
    return r.ok ? r.bytes : bytes;
  }
  let error = '';
  for (;;) {
    const v = await formSheet({
      title: 'PDF protegido',
      fields: [
        { type: 'note', text: error || t('"{nome}" está protegido. Digite a senha para abrir.', { nome: name || 'PDF' }) },
        { name: 'password', label: 'Senha', type: 'password' },
      ],
      ok: 'Abrir',
    });
    if (!v) return null;
    const r = await engine('unlock', { bytes: bytes.slice(), password: v.password });
    if (r.ok) return Object.assign(r.bytes, { password: v.password });
    error = r.reason === 'restricted' ? t('Esta senha só permite ler o documento. Use a senha do proprietário para editar.') : t('Senha incorreta. Tente de novo.');
  }
}

async function choosePdf(title = t('Escolha o PDF')) {
  let file = null;
  if (listDocs().length) {
    const pick = await libraryPick(title);
    if (!pick) return null;
    if (pick !== 'device') {
      const bytes = await readDoc(pick);
      const unlocked = await ensureUnlocked(bytes, pick.name);
      return unlocked && { name: pick.name, bytes: unlocked };
    }
  }
  [file] = await pickFiles({ accept: 'application/pdf' });
  if (!file) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const unlocked = await ensureUnlocked(bytes, file.name);
  return unlocked && { name: file.name, bytes: unlocked };
}

// ---------- resultados ----------

// preview: bytes sem senha para a miniatura (o pdf.js não abre o arquivo já protegido)
async function storePdf(bytes, name, preview = bytes) {
  const pdf = await loadPdf(preview.slice());
  const meta = await saveDoc({ name, bytes, pages: pdf.numPages, thumb: await thumbnail(pdf) });
  pdf.loadingTask?.destroy?.();
  return meta;
}

// Salva na biblioteca e oferece abrir ou compartilhar
async function finishPdf(bytes, name, text, preview) {
  const meta = await task('Salvando…', () => storePdf(bytes, name, preview));
  if (!meta) return;
  ctx.refresh();
  const s = sheet(`<div class="saved-ok">${icon('check', { size: 30, stroke: 2.6 })}</div>
    <p class="sheet-text center"><strong>${esc(t('Pronto!'))}</strong><br>${esc(text || t('Salvo nos seus arquivos como "{nome}".', { nome: meta.name }))}</p>
    <div class="sheet-actions">
      <button class="btn btn-primary" data-act="open">${icon('edit', { size: 20 })} ${esc(t('Abrir no editor'))}</button>
      <button class="btn btn-secondary" data-act="share">${icon('share', { size: 20 })} ${esc(t('Compartilhar'))}</button>
      <button class="btn btn-secondary" data-act="print">${icon('printer', { size: 20 })} ${esc(t('Imprimir'))}</button>
    </div>`);
  s.el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'open') { s.close(); ctx.openMeta(meta); }
    if (act === 'share') { try { await shareFiles([{ name: meta.name, bytes, mime: 'application/pdf' }]); } catch {} }
    if (act === 'print') { try { await printPdf(preview || bytes, meta.name); } catch { toast(t('Não foi possível imprimir.'), 'error'); } }
  });
}

async function finishFiles(files, text) {
  const s = sheet(`<div class="saved-ok">${icon('check', { size: 30, stroke: 2.6 })}</div>
    <p class="sheet-text center"><strong>${esc(t('Pronto!'))}</strong><br>${esc(text)}</p>
    <div class="sheet-actions"><button class="btn btn-primary" data-act="share">${icon('share', { size: 20 })} ${esc(t('Compartilhar ou salvar'))}</button></div>`);
  const share = async () => { try { await shareFiles(files); } catch {} };
  $('[data-act="share"]', s.el).addEventListener('click', share);
  share();
}

// ---------- utilidades de página ----------

// Matriz que leva o espaço "visual" da página (como ela aparece, já girada; y para cima) ao espaço do PDF
function visualSpace(page) {
  const { x, y, width: w, height: h } = page.getCropBox();
  const r = ((page.getRotation().angle % 360) + 360) % 360;
  if (r === 90) return { W: h, H: w, m: [0, 1, -1, 0, x + w, y] };
  if (r === 180) return { W: w, H: h, m: [-1, 0, 0, -1, x + w, y + h] };
  if (r === 270) return { W: h, H: w, m: [0, -1, 1, 0, x, y + h] };
  return { W: w, H: h, m: [1, 0, 0, 1, x, y] };
}

function inVisualSpace(page, draw) {
  const vs = visualSpace(page);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...vs.m));
  draw(vs.W, vs.H);
  page.pushOperators(popGraphicsState());
}

const hexToRgb = (hex) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex || '');
  return m ? rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255) : rgb(0, 0, 0);
};

let unicodeFont = null;
// Helvetica (padrão) cobre português; para outros caracteres usa a Liberation Sans do app
async function fontFor(doc, text, bold = false) {
  const std = await doc.embedFont(bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
  try { std.encodeText(text); return std; } catch {}
  doc.registerFontkit((await import('@pdf-lib/fontkit')).default);
  unicodeFont ||= new Uint8Array(await (await fetch(new URL('engine/LiberationSans-Regular.ttf', document.baseURI))).arrayBuffer());
  return doc.embedFont(unicodeFont, { subset: true });
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

const today = () => new Date().toLocaleDateString(getLang() === 'en' ? 'en-GB' : 'pt-BR');

async function copyPages(src, indices) {
  const out = await PDFDocument.create();
  for (const p of await out.copyPages(src, indices)) out.addPage(p);
  out.setProducer('Editor PDF (CyberSecInfo)');
  return out.save({ useObjectStreams: true });
}

// ---------- ferramentas ----------

async function compress() {
  const f = await choosePdf();
  if (!f) return;
  const v = await formSheet({
    title: 'Comprimir PDF',
    fields: [
      { type: 'note', text: t('Tamanho atual: {tamanho}. O resultado é salvo como um novo arquivo.', { tamanho: formatSize(f.bytes.length) }) },
      { name: 'level', label: 'Nível', type: 'select', value: 'medium', options: [
        ['low', 'Leve — melhor qualidade das imagens'], ['medium', 'Recomendado — equilíbrio'], ['high', 'Forte — menor arquivo'],
      ] },
    ],
    ok: 'Comprimir',
  });
  if (!v) return;
  const r = await task('Comprimindo…', () => engine('compress', { bytes: f.bytes.slice(), level: v.level }));
  if (!r) return;
  if (r.bytes.length >= f.bytes.length) return toast(t('Este PDF já está otimizado; comprimir não o deixaria menor.'));
  const pct = Math.round((1 - r.bytes.length / f.bytes.length) * 100);
  const msg = `${formatSize(f.bytes.length)} → ${formatSize(r.bytes.length)} (${pct > 0 ? `−${pct}%` : t('já estava otimizado')})`;
  await finishPdf(r.bytes, `${baseName(f.name)}${t(' (comprimido)')}`, msg);
}

async function ocr() {
  const f = await choosePdf();
  if (!f) return;
  const v = await formSheet({
    title: 'OCR — reconhecer texto',
    fields: [
      { type: 'note', text: 'Lê o texto de páginas escaneadas e fotos (português e inglês) e grava de forma invisível: o PDF fica pesquisável e dá para copiar o texto. Tudo é feito no celular.' },
      { name: 'force', label: 'Ler também páginas que já têm texto', type: 'checkbox', value: false },
    ],
    ok: 'Reconhecer',
  });
  if (!v) return;
  const r = await task('Reconhecendo texto…', (p) => engine('ocr', { bytes: f.bytes.slice(), force: v.force }, p));
  if (!r) return;
  if (!r.pages) return toast(t('As páginas já tinham texto. Marque "Ler também páginas que já têm texto" para forçar.'));
  await finishPdf(r.bytes, `${baseName(f.name)}${t(' (OCR)')}`, t('Texto reconhecido em {n} página(s) ({p} palavras).', { n: r.pages, p: r.words }));
}

async function toWord() {
  const f = await choosePdf();
  if (!f) return;
  const r = await task('Convertendo para Word…', (p) => engine('toDocx', { bytes: f.bytes.slice(), title: baseName(f.name) }, p));
  if (!r) return;
  await finishFiles([{ name: `${baseName(f.name)}.docx`, bytes: r.bytes, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }],
    t('Word criado: {nome}', { nome: `${baseName(f.name)}.docx` }));
}

async function toImages() {
  const f = await choosePdf();
  if (!f) return;
  const total = (await PDFDocument.load(f.bytes, { updateMetadata: false })).getPageCount();
  const v = await formSheet({
    title: 'PDF → Imagens',
    fields: [
      { name: 'format', label: 'Formato', type: 'select', value: 'jpg', options: [['jpg', 'JPG'], ['png', 'PNG']] },
      { name: 'dpi', label: 'Qualidade (DPI)', type: 'select', value: '150', options: [['96', '96 (tela)'], ['150', '150 (padrão)'], ['300', '300 (impressão)']] },
      { name: 'which', label: 'Páginas', type: 'select', value: 'all', options: [['all', t('Todas ({n})', { n: total })], ['some', 'Escolher páginas']] },
      { name: 'ranges', label: 'Quais páginas (ex.: 1-3, 5)', show: (x) => x.which === 'some' },
    ],
    ok: 'Gerar imagens',
    validate: (x) => (x.which === 'some' && !parseRanges(x.ranges, total).length ? 'Nenhum intervalo válido.' : null),
  });
  if (!v) return;
  const pages = v.which === 'some' ? [...new Set(parseRanges(v.ranges, total).flat())].sort((a, b) => a - b) : [...Array(total).keys()];
  const r = await task('Gerando imagens…', () => engine('renderPages', { bytes: f.bytes.slice(), dpi: Number(v.dpi), format: v.format, pages }));
  if (!r) return;
  const pad = String(total).length;
  const files = r.images.map((bytes, k) => ({
    name: t('{base} - página {n}.{ext}', { base: baseName(f.name), n: String(pages[k] + 1).padStart(pad, '0'), ext: v.format }),
    bytes, mime: v.format === 'png' ? 'image/png' : 'image/jpeg',
  }));
  await finishFiles(files, t('{n} imagem(ns) criadas.', { n: files.length }));
}

async function toText() {
  const f = await choosePdf();
  if (!f) return;
  const r = await task('Extraindo texto…', () => engine('structuredText', { bytes: f.bytes.slice() }));
  if (!r) return;
  const text = r.pages.map((p, i) => `${t('--- Página {n} ---', { n: i + 1 })}\r\n${p.text.replace(/\r?\n/g, '\r\n').trim()}\r\n`).join('\r\n');
  if (!text.replace(/---[^\n]*---|\s/g, '')) toast(t('Este PDF não tem texto. Use o OCR antes para reconhecer o texto das páginas.'));
  await finishFiles([{ name: `${baseName(f.name)}.txt`, bytes: new TextEncoder().encode('﻿' + text), mime: 'text/plain' }],
    t('Texto salvo: {nome}', { nome: `${baseName(f.name)}.txt` }));
}

async function pdfa() {
  const f = await choosePdf();
  if (!f) return;
  const report = await task('Preparando…', () => engine('fontReport', { bytes: f.bytes.slice() }));
  if (!report) return;
  let mode = 'keep';
  if (report.missing.length) {
    const ok = await confirmSheet({
      title: 'PDF/A',
      text: t('Este PDF usa fontes que não estão dentro do arquivo ({fontes}). Para um PDF/A válido, as páginas serão convertidas em imagem com o texto reconhecido por OCR (continua pesquisável e copiável). Continuar?', { fontes: report.missing.slice(0, 6).join(', ') }),
      ok: t('Converter'),
    });
    if (!ok) return;
    mode = 'raster';
  }
  const r = await task('Gerando PDF/A…', (p) => engine('pdfa', { bytes: f.bytes.slice(), title: baseName(f.name), lang: getLang() === 'en' ? 'en-US' : 'pt-BR', mode }, p));
  if (!r) return;
  if (!r.ok) return toast(t('fontes não incorporadas: {fontes}', { fontes: (r.fonts || []).join(', ') }), 'error');
  await finishPdf(r.bytes, `${baseName(f.name)} (PDF-A)`, t('PDF/A pronto para arquivamento.'));
}

function permissionsFrom(p) {
  let bits = -4; // tudo liberado
  if (p.noPrint) bits &= ~(4 | 2048);
  if (p.noCopy) bits &= ~16;
  if (p.noEdit) bits &= ~(8 | 32 | 1024);
  return bits;
}

async function protect() {
  const f = await choosePdf();
  if (!f) return;
  const v = await formSheet({
    title: 'Proteger com senha',
    fields: [
      { type: 'note', text: 'O PDF vai pedir a senha para abrir (criptografia AES-256).' },
      { name: 'user', label: 'Senha para abrir', type: 'password' },
      { name: 'confirm', label: 'Repita a senha', type: 'password' },
      { name: 'limit', label: 'Restringir impressão, cópia ou edição', type: 'checkbox', value: false },
      { name: 'noPrint', label: 'Impedir impressão', type: 'checkbox', show: (x) => x.limit },
      { name: 'noCopy', label: 'Impedir copiar texto e imagens', type: 'checkbox', show: (x) => x.limit },
      { name: 'noEdit', label: 'Impedir edição', type: 'checkbox', show: (x) => x.limit },
      { name: 'owner', label: 'Senha do proprietário (libera as restrições)', type: 'password', show: (x) => x.limit },
    ],
    ok: 'Proteger',
    validate: (x) => {
      if (!x.user) return 'Digite a senha.';
      if (x.user !== x.confirm) return 'As senhas não conferem.';
      if (/,/.test(x.user + x.owner)) return 'A senha não pode ter vírgula.';
      if (x.limit && (x.noPrint || x.noCopy || x.noEdit) && !x.owner) return 'Para usar restrições, defina a senha do proprietário.';
      if (x.limit && x.owner && x.owner === x.user) return 'A senha do proprietário precisa ser diferente.';
      return null;
    },
  });
  if (!v) return;
  const limited = v.limit && (v.noPrint || v.noCopy || v.noEdit);
  const encrypt = { user: v.user, owner: limited ? v.owner : v.user, ...(limited && { permissions: permissionsFrom(v) }) };
  const r = await task('Protegendo…', () => engine('finalize', { bytes: f.bytes.slice(), encrypt }));
  if (r) await finishPdf(r.bytes, `${baseName(f.name)}${t(' (protegido)')}`, t('O PDF agora pede a senha para abrir. Guarde a senha: sem ela não há como abrir o arquivo.'), f.bytes);
}

async function unprotect() {
  let file = null;
  if (listDocs().length) {
    const pick = await libraryPick(t('Escolha o PDF protegido'));
    if (!pick) return;
    if (pick !== 'device') file = { name: pick.name, bytes: await readDoc(pick) };
  }
  if (!file) {
    const [x] = await pickFiles({ accept: 'application/pdf' });
    if (!x) return;
    file = { name: x.name, bytes: new Uint8Array(await x.arrayBuffer()) };
  }
  const info = await task('Verificando…', () => engine('inspect', { bytes: file.bytes.slice() }));
  if (!info) return;
  if (!info.encrypted) return toast(t('Este PDF não tem senha.'));
  const bytes = await ensureUnlocked(file.bytes, file.name);
  if (!bytes) return;
  await finishPdf(bytes, `${baseName(file.name)}${t(' (sem senha)')}`, t('Senha removida. O novo arquivo abre sem pedir senha.'));
}

async function sanitize() {
  const f = await choosePdf();
  if (!f) return;
  const ok = await confirmSheet({
    title: t('Remover metadados'),
    text: t('Apaga autor, programa de origem, assunto e palavras-chave, que podem revelar informações sobre você, e reescreve o arquivo limpo. O conteúdo visível não muda.'),
    ok: t('Remover'),
  });
  if (!ok) return;
  const r = await task('Limpando…', () => engine('finalize', { bytes: f.bytes.slice(), sanitize: true }));
  if (r) await finishPdf(r.bytes, `${baseName(f.name)}${t(' (limpo)')}`, t('Metadados removidos.'));
}

async function split() {
  const f = await choosePdf();
  if (!f) return;
  const src = await PDFDocument.load(f.bytes, { updateMetadata: false });
  const total = src.getPageCount();
  if (total < 2) return toast(t('Este PDF tem só uma página.'));
  const v = await formSheet({
    title: 'Dividir PDF',
    fields: [
      { name: 'mode', label: 'Como dividir', type: 'select', value: 'every', options: [
        ['every', 'A cada N páginas'], ['ranges', 'Por intervalos (ex.: 1-3, 4, 5-8)'], ['each', 'Uma página por arquivo'],
      ] },
      { name: 'every', label: 'N (páginas por arquivo)', type: 'number', min: 1, max: total, value: Math.min(2, total), show: (x) => x.mode === 'every' },
      { name: 'ranges', label: 'Intervalos', placeholder: `1-${Math.ceil(total / 2)}, ${Math.ceil(total / 2) + 1}-${total}`, show: (x) => x.mode === 'ranges' },
    ],
    ok: 'Dividir',
  });
  if (!v) return;
  let groups = [];
  if (v.mode === 'each') groups = [...Array(total).keys()].map((i) => [i]);
  else if (v.mode === 'every') { const n = Math.max(1, v.every || 1); for (let i = 0; i < total; i += n) groups.push([...Array(Math.min(n, total - i)).keys()].map((k) => i + k)); }
  else groups = parseRanges(v.ranges, total);
  if (!groups.length) return toast(t('Nenhum intervalo válido.'), 'error');
  const files = await task('Dividindo…', async (p) => {
    const out = [];
    for (const [i, g] of groups.entries()) {
      p({ message: 'Criando arquivo {i} de {n}…', vars: { i: i + 1, n: groups.length } });
      const range = g.length > 1 ? `${g[0] + 1}-${g[g.length - 1] + 1}` : `${g[0] + 1}`;
      const name = t('{base} (parte {i} - pág {faixa}).pdf', { base: baseName(f.name), i: i + 1, faixa: range });
      const bytes = await copyPages(src, g);
      await storePdf(bytes, name);
      out.push({ name, bytes, mime: 'application/pdf' });
    }
    return out;
  });
  if (!files) return;
  ctx.refresh();
  await finishFiles(files, t('{n} arquivo(s) criados e salvos nos seus arquivos.', { n: files.length }));
}

async function extract() {
  const f = await choosePdf();
  if (!f) return;
  const src = await PDFDocument.load(f.bytes, { updateMetadata: false });
  const total = src.getPageCount();
  const v = await formSheet({
    title: 'Extrair páginas',
    fields: [
      { type: 'note', text: t('O documento tem {n} página(s). As páginas escolhidas viram um PDF novo; o original não muda.', { n: total }) },
      { name: 'ranges', label: 'Quais páginas (ex.: 1-3, 5)', placeholder: total > 1 ? `1, 3-${total}` : '1' },
    ],
    ok: 'Extrair',
    validate: (x) => (!parseRanges(x.ranges, total).length ? 'Nenhum intervalo válido.' : null),
  });
  if (!v) return;
  const indices = parseRanges(v.ranges, total).flat();
  const bytes = await task('Extraindo páginas…', () => copyPages(src, indices));
  if (!bytes) return;
  const label = indices.length === 1 ? t('página {n}', { n: indices[0] + 1 }) : t('páginas {lista}', { lista: v.ranges.replace(/\s+/g, '') });
  await finishPdf(bytes, `${baseName(f.name)} (${label})`, t('{n} página(s) extraídas.', { n: indices.length }));
}

async function imageBytesToPng(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
}

async function watermark() {
  const f = await choosePdf();
  if (!f) return;
  const v = await formSheet({
    title: "Marca d'água",
    fields: [
      { name: 'kind', label: 'Tipo', type: 'select', value: 'text', options: [['text', 'Texto'], ['logo', 'Imagem (logo)']] },
      { name: 'text', label: 'Texto', value: t('CONFIDENCIAL'), show: (x) => x.kind === 'text' },
      { name: 'size', label: 'Tamanho', type: 'number', min: 8, max: 200, value: 60, show: (x) => x.kind === 'text' },
      { name: 'color', label: 'Cor', type: 'color', value: '#c62828', show: (x) => x.kind === 'text' },
      { name: 'angle', label: 'Ângulo', type: 'number', min: -90, max: 90, value: -35 },
      { name: 'opacity', label: 'Opacidade (%)', type: 'number', min: 5, max: 100, value: 18 },
    ],
    ok: 'Continuar',
    validate: (x) => (x.kind === 'text' && !x.text.trim() ? 'Digite o texto.' : null),
  });
  if (!v) return;
  let logo = null;
  if (v.kind === 'logo') {
    const [img] = await pickFiles({ accept: 'image/*' });
    if (!img) return;
    logo = await imageBytesToPng(img);
  }
  const bytes = await task("Aplicando marca d'água…", async () => {
    const doc = await PDFDocument.load(f.bytes, { updateMetadata: false });
    const opacity = Math.max(0.05, Math.min(1, (v.opacity || 18) / 100));
    const th = ((v.angle || 0) * Math.PI) / 180;
    const font = logo ? null : await fontFor(doc, v.text, true);
    const image = logo ? await doc.embedPng(logo) : null;
    for (const page of doc.getPages()) {
      inVisualSpace(page, (W, H) => {
        let w; let hgt;
        if (image) { w = W * 0.5; hgt = (image.height / image.width) * w; } else { w = font.widthOfTextAtSize(v.text, v.size); hgt = v.size * 0.7; }
        // Origem do desenho = centro da página menos o meio do conteúdo, girado
        const x = W / 2 - (Math.cos(th) * w) / 2 + (Math.sin(th) * hgt) / 2;
        const y = H / 2 - (Math.sin(th) * w) / 2 - (Math.cos(th) * hgt) / 2;
        if (image) page.drawImage(image, { x, y, width: w, height: hgt, opacity, rotate: degrees(v.angle || 0) });
        else page.drawText(v.text, { x, y, size: v.size, font, color: hexToRgb(v.color), opacity, rotate: degrees(v.angle || 0) });
      });
    }
    return doc.save({ useObjectStreams: true });
  });
  if (bytes) await finishPdf(bytes, `${baseName(f.name)}${t(" (marca d'água)")}`, t("Marca d'água aplicada em todas as páginas."));
}

const SLOTS = ['tl', 'tc', 'tr', 'bl', 'bc', 'br'];

async function stampHeaderFooter(f, cfg, suffix, doneText) {
  const bytes = await task('Aplicando…', async () => {
    const doc = await PDFDocument.load(f.bytes, { updateMetadata: false });
    const pages = doc.getPages();
    const start = cfg.start ?? 1;
    const fill = (tpl, i) => tpl.replaceAll('{n}', String(start + i)).replaceAll('{total}', String(pages.length + start - 1))
      .replaceAll('{data}', today()).replaceAll('{date}', today()).replaceAll('{arquivo}', baseName(f.name)).replaceAll('{file}', baseName(f.name));
    const all = SLOTS.map((s) => cfg[s] || '').join(' ');
    const font = await fontFor(doc, fill(all, 0) + '0123456789');
    const size = cfg.size || 9;
    const m = cfg.margin || 22;
    const color = hexToRgb(cfg.color || '#444444');
    pages.forEach((page, i) => {
      if (cfg.skipFirst && i === 0) return;
      inVisualSpace(page, (W, H) => {
        for (const slot of SLOTS) {
          if (!cfg[slot]) continue;
          const text = fill(cfg[slot], i);
          const w = font.widthOfTextAtSize(text, size);
          const x = slot[1] === 'l' ? m : slot[1] === 'c' ? (W - w) / 2 : W - m - w;
          const y = slot[0] === 't' ? H - m - size * 0.8 : m;
          page.drawText(text, { x, y, size, font, color });
        }
      });
    });
    return doc.save({ useObjectStreams: true });
  });
  if (bytes) await finishPdf(bytes, `${baseName(f.name)}${suffix}`, doneText);
}

async function pageNumbers() {
  const f = await choosePdf();
  if (!f) return;
  const v = await formSheet({
    title: 'Numerar páginas',
    fields: [
      { name: 'format', label: 'Formato', type: 'select', value: 'pg', options: [['n', '1, 2, 3…'], ['pg', t('Página {n} de {total}')], ['slash', '1 / 10']] },
      { name: 'pos', label: 'Posição', type: 'select', value: 'bc', options: [
        ['bc', 'Rodapé — centro'], ['br', 'Rodapé — direita'], ['bl', 'Rodapé — esquerda'], ['tc', 'Cabeçalho — centro'], ['tr', 'Cabeçalho — direita'], ['tl', 'Cabeçalho — esquerda'],
      ] },
      { name: 'size', label: 'Tamanho', type: 'number', min: 6, max: 30, value: 10 },
      { name: 'start', label: 'Começar a numeração em', type: 'number', min: 0, max: 9999, value: 1 },
      { name: 'skipFirst', label: 'Não numerar a primeira página', type: 'checkbox', value: false },
    ],
    ok: 'Numerar',
  });
  if (!v) return;
  const tpl = { n: '{n}', pg: t('Página {n} de {total}'), slash: '{n} / {total}' }[v.format];
  await stampHeaderFooter(f, { [v.pos]: tpl, size: v.size, start: v.start ?? 1, skipFirst: v.skipFirst, color: '#333333' }, t(' (numerado)'), t('Páginas numeradas.'));
}

async function headerFooter() {
  const f = await choosePdf();
  if (!f) return;
  const v = await formSheet({
    title: 'Cabeçalho e rodapé',
    fields: [
      { type: 'note', text: 'Use {n} para o número da página, {total} para o total, {data} para a data e {arquivo} para o nome do arquivo.' },
      { name: 'tl', label: 'Cabeçalho — esquerda' },
      { name: 'tc', label: 'Cabeçalho — centro' },
      { name: 'tr', label: 'Cabeçalho — direita' },
      { name: 'bl', label: 'Rodapé — esquerda' },
      { name: 'bc', label: 'Rodapé — centro', value: t('Página {n} de {total}') },
      { name: 'br', label: 'Rodapé — direita' },
      { name: 'size', label: 'Tamanho', type: 'number', min: 6, max: 30, value: 9 },
      { name: 'color', label: 'Cor', type: 'color', value: '#444444' },
      { name: 'start', label: 'Começar a numeração em', type: 'number', min: 0, max: 9999, value: 1 },
      { name: 'skipFirst', label: 'Não colocar na primeira página', type: 'checkbox', value: false },
    ],
    ok: 'Aplicar',
    validate: (x) => (!SLOTS.some((s) => x[s].trim()) ? 'Preencha ao menos um campo.' : null),
  });
  if (!v) return;
  await stampHeaderFooter(f, v, t(' (cabeçalho e rodapé)'), t('Cabeçalho e rodapé aplicados.'));
}

async function properties() {
  const f = await choosePdf();
  if (!f) return;
  const doc = await PDFDocument.load(f.bytes, { updateMetadata: false });
  const lang = doc.catalog.lookup(PDFName.of('Lang'));
  const v = await formSheet({
    title: 'Propriedades do documento',
    fields: [
      { name: 'title', label: 'Título', value: doc.getTitle() || '' },
      { name: 'author', label: 'Autor', value: doc.getAuthor() || '' },
      { name: 'subject', label: 'Assunto', value: doc.getSubject() || '' },
      { name: 'keywords', label: 'Palavras-chave (separadas por vírgula)', value: doc.getKeywords() || '' },
      { name: 'lang', label: 'Idioma do documento (leitores de tela)', type: 'select', value: lang?.decodeText?.() || '', options: [
        ['', 'Não definido'], ['pt-BR', 'Português (Brasil)'], ['pt-PT', 'Português (Portugal)'], ['en-US', 'Inglês (EUA)'], ['en-GB', 'Inglês (Reino Unido)'], ['es', 'Espanhol'],
      ] },
    ],
    ok: 'Salvar',
  });
  if (!v) return;
  doc.setTitle(v.title, { showInWindowTitleBar: !!v.title });
  doc.setAuthor(v.author);
  doc.setSubject(v.subject);
  doc.setKeywords(v.keywords ? v.keywords.split(',').map((k) => k.trim()).filter(Boolean) : []);
  if (v.lang) doc.catalog.set(PDFName.of('Lang'), PDFString.of(v.lang)); else doc.catalog.delete(PDFName.of('Lang'));
  doc.setModificationDate(new Date());
  await finishPdf(await doc.save({ useObjectStreams: true }), baseName(f.name), t('Propriedades gravadas.'));
}

function lcsDiff(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > 4e6) return { onlyA: a.map((_, i) => i).filter((i) => !b.includes(a[i])), onlyB: b.map((_, j) => j).filter((j) => !a.includes(b[j])) };
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const onlyA = [];
  const onlyB = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) onlyA.push(i++); else onlyB.push(j++);
  }
  while (i < n) onlyA.push(i++);
  while (j < m) onlyB.push(j++);
  return { onlyA, onlyB };
}

async function compare() {
  const a = await choosePdf(t('Escolha o primeiro PDF'));
  if (!a) return;
  const b = await choosePdf(t('Escolha o PDF para comparar'));
  if (!b) return;
  const r = await task('Comparando…', async () => {
    const [ta, tb] = await Promise.all([engine('structuredText', { bytes: a.bytes.slice() }), engine('structuredText', { bytes: b.bytes.slice() })]);
    const lines = (p) => p.text.split(/\r?\n/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const added = [];
    const removed = [];
    const total = Math.max(ta.pages.length, tb.pages.length);
    for (let i = 0; i < total; i++) {
      const la = ta.pages[i] ? lines(ta.pages[i]) : [];
      const lb = tb.pages[i] ? lines(tb.pages[i]) : [];
      const { onlyA, onlyB } = lcsDiff(la, lb);
      for (const k of onlyA) added.push({ page: i + 1, text: la[k] });
      for (const k of onlyB) removed.push({ page: i + 1, text: lb[k] });
    }
    return { added, removed, pagesA: ta.pages.length, pagesB: tb.pages.length };
  });
  if (!r) return;
  const out = [];
  if (r.pagesA !== r.pagesB) out.push(t('Páginas: {a} no primeiro, {b} no segundo.', { a: r.pagesA, b: r.pagesB }), '');
  if (!r.added.length && !r.removed.length) out.push(t('Nenhuma diferença de texto encontrada.'));
  for (const d of r.added) out.push(`+ ${t('pág. {n}', { n: d.page })}: ${d.text}`);
  for (const d of r.removed) out.push(`− ${t('pág. {n}', { n: d.page })}: ${d.text}`);
  const report = out.join('\n');
  const s = sheet(`<p class="sheet-text">${esc(t('"+" = só em "{a}". "−" = só em "{b}".', { a: a.name, b: b.name }))}<br>${esc(t('{x} trecho(s) diferentes.', { x: r.added.length + r.removed.length }))}</p>
    <pre class="report">${esc(report)}</pre>
    <div class="sheet-actions"><button class="btn btn-secondary" data-share>${icon('share', { size: 20 })} ${esc(t('Compartilhar relatório'))}</button></div>`, { title: t('Comparação') });
  $('[data-share]', s.el).addEventListener('click', async () => {
    try { await shareFiles([{ name: t('comparação - {a} x {b}.txt', { a: baseName(a.name), b: baseName(b.name) }), bytes: new TextEncoder().encode('﻿' + report.replace(/\n/g, '\r\n')), mime: 'text/plain' }]); } catch {}
  });
}

export const TOOL_GROUPS = [
  ['Editar', [
    ['annotate', 'highlighter', 'Anotar e marcar', 'Texto, marca-texto, caneta, formas, notas e carimbos.'],
    ['edittext', 'edit', 'Editar texto do PDF', 'Toque numa frase para corrigir o texto original.'],
    ['sign', 'signature', 'Assinar documento', 'Desenhe sua assinatura e coloque no PDF.'],
    ['forms', 'form', 'Preencher formulário', 'Preencha campos, marque caixas e crie campos novos.'],
    ['pages', 'pages', 'Organizar páginas', 'Gire, exclua, reordene, duplique e adicione páginas.'],
  ]],
  ['Criar e juntar', [
    ['merge', 'merge', 'Juntar PDFs', 'Junte vários PDFs em um só, na ordem que quiser.'],
    ['images', 'images', 'Imagens em PDF', 'Transforme fotos e imagens em um PDF.'],
  ]],
  ['Otimizar', [
    ['compress', 'shrink', 'Comprimir PDF', 'Deixe o arquivo menor para enviar por e-mail ou WhatsApp.'],
    ['ocr', 'scan', 'Reconhecer texto (OCR)', 'Torne pesquisável um PDF escaneado ou foto de documento.'],
  ]],
  ['Converter', [
    ['word', 'word', 'PDF para Word', 'Converta para .docx e edite no Word.'],
    ['toImages', 'image', 'PDF para imagens', 'Cada página vira uma imagem JPG ou PNG.'],
    ['toText', 'text', 'PDF para texto', 'Extraia todo o texto num arquivo .txt.'],
    ['pdfa', 'archive', 'PDF/A (arquivamento)', 'Formato exigido por tribunais e órgãos públicos.'],
  ]],
  ['Páginas', [
    ['split', 'split', 'Dividir PDF', 'Separe em vários arquivos por intervalo ou página.'],
    ['extract', 'extract', 'Extrair páginas', 'Copie páginas escolhidas para um PDF novo.'],
  ]],
  ['Documento', [
    ['watermark', 'drop', "Marca d'água", 'Texto ou logo em todas as páginas.'],
    ['numbers', 'hash', 'Numerar páginas', 'Coloque o número em cada página.'],
    ['headerFooter', 'layout', 'Cabeçalho e rodapé', 'Texto, data e numeração no topo e no pé.'],
    ['properties', 'tag', 'Propriedades', 'Título, autor, assunto e idioma.'],
    ['compare', 'diff', 'Comparar PDFs', 'Veja o que mudou entre duas versões.'],
  ]],
  ['Proteger', [
    ['redact', 'redact', 'Tarjar (apagar de verdade)', 'Esconda dados sensíveis: o texto embaixo é apagado do arquivo.'],
    ['protect', 'lock', 'Proteger com senha', 'Exija senha para abrir e limite impressão ou cópia.'],
    ['unprotect', 'unlock', 'Remover senha', 'Crie uma cópia que abre sem senha.'],
    ['sanitize', 'eraser', 'Remover metadados', 'Apague autor, programa de origem e outros dados ocultos.'],
  ]],
];

export const TOOL_ACTIONS = {
  compress, ocr, word: toWord, toImages, toText, pdfa, protect, unprotect, sanitize,
  split, extract, watermark, numbers: pageNumbers, headerFooter, properties, compare,
};
