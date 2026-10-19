// Leitura (pdf.js), gravação (pdf-lib) e as ferramentas de documento inteiro (juntar, imagens em PDF).
import * as pdfjs from 'pdfjs-dist/build/pdf.min.mjs';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { engine } from './engine.js';
import { PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList, StandardFonts, rgb, degrees, pushGraphicsState, popGraphicsState, concatTransformationMatrix } from 'pdf-lib';
import { fabric, TEXT_BASELINE_RATIO, LINE_MULT } from './fabric-setup.js';
import { detectBoxes } from '../../app/js/boxes.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// O Safari (iPhone, até o iOS 26) não percorre ReadableStream com "for await", que o getTextContent do pdf.js usa:
// sem isto, ler o texto da página dava erro e o "Editar frase" não fazia nada ao tocar.
if (typeof ReadableStream !== 'undefined' && !ReadableStream.prototype[Symbol.asyncIterator]) {
  ReadableStream.prototype[Symbol.asyncIterator] = async function* () {
    const reader = this.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  };
}

const ASSETS = new URL('pdfjs/', document.baseURI).href;

export function loadPdf(bytes) {
  return pdfjs.getDocument({
    data: bytes.slice(), // o pdf.js toma posse do buffer
    cMapUrl: ASSETS + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: ASSETS + 'standard_fonts/',
    wasmUrl: ASSETS + 'wasm/',
    iccUrl: ASSETS + 'iccs/',
    isEvalSupported: false,
    enableXfa: false,
    fontExtraProperties: true, // nome real da fonte (negrito/itálico ao editar uma frase)
  }).promise;
}

export const isPasswordError = (err) => err?.name === 'PasswordException';

// Miniatura em JPEG (para a lista de arquivos)
export async function thumbnail(pdfDoc, pageNumber = 1, width = 132) {
  const page = await pdfDoc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
  return canvas.toDataURL('image/jpeg', 0.72);
}

// Composição de matrizes afins no formato do PDF [a b c d e f]: aplica m1 e depois m2
function mul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

function inv(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

const hexToRgb = (hex) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex || '');
  return m ? rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255) : rgb(0, 0, 0);
};

const RASTER_SCALE = 2.5; // ~180 dpi para caneta, marca-texto e imagens

// Grava as anotações de uma página. Tudo é desenhado no espaço da página como ela aparece na tela
// (já girada), com y para cima; a matriz leva esse espaço para o espaço do PDF.
async function stampPage(outDoc, outPage, viewport, objects, fontOf, fill = () => false) {
  if (!objects?.length) return;
  const W = viewport.width;
  const H = viewport.height;
  const toPdf = mul([1, 0, 0, -1, 0, H], inv(viewport.transform));

  const texts = [];
  const raster = [];
  const boxes = []; // tarjas, marca-texto e traços sem giro: retângulo vetorial (em PNG a borda fica com halo cinza)
  const toUser = (x, y) => [toPdf[0] * x + toPdf[2] * y + toPdf[4], toPdf[1] * x + toPdf[3] * y + toPdf[5]];
  // Texto escrito em cima de um campo de formulário preenche o campo (o campo é desenhado por cima do conteúdo)
  const live = await fabric.util.enlivenObjects(objects.filter((o) => o.type?.toLowerCase().includes('text') && o.text));
  const filled = new Set();
  live.forEach((obj) => {
    const c = obj.getCenterPoint();
    if (fill(obj.text, toUser(c.x, H - c.y))) filled.add(obj.text + '|' + Math.round(obj.left) + '|' + Math.round(obj.top));
  });
  objects = objects.filter((o) => !filled.has(o.text + '|' + Math.round(o.left) + '|' + Math.round(o.top)));
  for (const o of objects) {
    if (FIELD_KINDS.has(o.kind)) continue; // viram campos de formulário de verdade (buildPdf)
    if (o.kind === 'edit-cover') continue; // a frase original já foi apagada de verdade: o fundo real aparece
    if (o.type?.toLowerCase().includes('text') && o.text) {
      try { (await fontOf(o)).encodeText(o.text.replace(/\n/g, '')); texts.push(o); } catch { raster.push(o); }
    } else if (BOX_KINDS.has(o.kind) && !(o.angle % 360) && typeof o.fill === 'string' && o.fill.startsWith('#')) boxes.push(o);
    else raster.push(o);
  }

  outPage.pushOperators(pushGraphicsState(), concatTransformationMatrix(...toPdf));

  if (boxes.length) {
    for (const obj of await fabric.util.enlivenObjects(boxes)) {
      obj.setCoords();
      const { tl, br } = obj.aCoords;
      outPage.drawRectangle({
        x: tl.x, y: H - br.y, width: br.x - tl.x, height: br.y - tl.y,
        color: hexToRgb(obj.fill), opacity: obj.opacity ?? 1, borderWidth: 0,
      });
    }
  }

  if (raster.length) {
    const el = document.createElement('canvas');
    const sc = new fabric.StaticCanvas(el, { width: Math.ceil(W * RASTER_SCALE), height: Math.ceil(H * RASTER_SCALE), enableRetinaScaling: false });
    sc.setZoom(RASTER_SCALE);
    await sc.loadFromJSON({ objects: raster });
    sc.renderAll();
    const png = await outDoc.embedPng(sc.toDataURL({ format: 'png', multiplier: 1 }));
    outPage.drawImage(png, { x: 0, y: 0, width: W, height: H });
    sc.dispose();
  }

  if (texts.length) {
    const live = await fabric.util.enlivenObjects(texts);
    for (const obj of live) {
      obj.setCoords();
      const tl = obj.aCoords.tl;
      const size = obj.fontSize * obj.scaleY;
      const th = (obj.angle * Math.PI) / 180;
      const color = hexToRgb(typeof obj.fill === 'string' ? obj.fill : '#000000');
      const font = await fontOf(obj);
      // Nota: fundo amarelo atrás do texto
      if (obj.backgroundColor && !(obj.angle % 360)) {
        const { br } = obj.aCoords;
        outPage.drawRectangle({ x: tl.x, y: H - br.y, width: br.x - tl.x, height: br.y - tl.y, color: hexToRgb(obj.backgroundColor), borderWidth: 0 });
      }
      // textLines já traz as quebras automáticas da caixa de texto (nota)
      (obj.textLines?.map((l) => (Array.isArray(l) ? l.join('') : l)) || obj.text.split('\n')).forEach((line, i) => {
        if (!line) return;
        const by = i * size * LINE_MULT * obj.lineHeight + size * TEXT_BASELINE_RATIO;
        const bounds = obj.charSpacing ? obj.__charBounds?.[i] : null;
        if (bounds) {
          // caixinhas de formulário: cada letra na posição medida pelo fabric (com o espaçamento entre letras)
          (obj._textLines?.[i] || Array.from(line)).forEach((ch, j) => {
            if (!ch.trim() || !bounds[j]) return;
            const dx = bounds[j].left * obj.scaleX;
            const cx = tl.x + Math.cos(th) * dx - Math.sin(th) * by;
            const cy = tl.y + Math.sin(th) * dx + Math.cos(th) * by;
            outPage.drawText(ch, { x: cx, y: H - cy, size, font, color, rotate: degrees(-obj.angle) });
          });
          return;
        }
        const x = tl.x - Math.sin(th) * by;
        const y = tl.y + Math.cos(th) * by;
        outPage.drawText(line, { x, y: H - y, size, font, color, rotate: degrees(-obj.angle) });
      });
    }
  }

  outPage.pushOperators(popGraphicsState());
}

// Campos de formulário (texto e caixa de marcar) com o retângulo de cada widget e a página dele
function formWidgets(pdfDoc) {
  const list = [];
  let form;
  try { form = pdfDoc.getForm(); } catch { return list; }
  const pageRefs = pdfDoc.getPages().map((pg) => pg.ref);
  for (const field of form.getFields()) {
    if (!(field instanceof PDFTextField) && !(field instanceof PDFCheckBox)) continue;
    if (field.isReadOnly?.()) continue;
    for (const w of field.acroField.getWidgets()) {
      const r = w.getRectangle();
      let pageRef = w.P();
      if (!pageRef || !pageRefs.includes(pageRef)) {
        const wRef = pdfDoc.context.getObjectRef(w.dict);
        pageRef = pdfDoc.getPages().find((pg) => pg.node.Annots()?.asArray().includes(wRef))?.ref;
      }
      if (pageRef) list.push({ field, pageRef, x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height });
    }
  }
  return list;
}

// Fontes padrão do PDF (não precisam ir dentro do arquivo), escolhidas pela família, negrito e itálico do texto
function standardFonts(out) {
  const cache = new Map();
  return (obj) => {
    const fam = String(obj.fontFamily || '');
    const bold = obj.fontWeight === 'bold' || Number(obj.fontWeight) >= 600;
    const italic = obj.fontStyle === 'italic';
    const kind = /times|serif/i.test(fam) && !/sans/i.test(fam) ? 'times' : /courier|mono/i.test(fam) ? 'courier' : 'helv';
    const name = {
      helv: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
      times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
      courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
    }[kind][(bold ? 1 : 0) + (italic ? 2 : 0)];
    if (!cache.has(name)) cache.set(name, out.embedFont(name));
    return cache.get(name);
  };
}

// ---------- Formulários ----------
const fieldType = (f) => (f instanceof PDFTextField ? 'text' : f instanceof PDFCheckBox ? 'check' : f instanceof PDFRadioGroup ? 'radio'
  : f instanceof PDFDropdown ? 'dropdown' : f instanceof PDFOptionList ? 'list' : null);

// Campos do PDF com valor atual, opções e o retângulo de cada widget (espaço do PDF) por página
// Caixinhas, caixas de marcar e linhas de um formulário "chapado" (sem campos), em coordenadas do viewport
export async function pageBoxes(pg, viewport) {
  const [opList, textContent] = await Promise.all([pg.getOperatorList(), pg.getTextContent()]);
  return detectBoxes({ opList, textContent, OPS: pdfjs.OPS, viewport });
}

export async function readForm(bytes) {
  let d;
  try { d = await PDFDocument.load(bytes, { updateMetadata: false }); } catch { return { fields: [] }; }
  let form;
  try { form = d.getForm(); } catch { return { fields: [] }; }
  const pages = d.getPages();
  const fields = [];
  for (const f of form.getFields()) {
    const type = fieldType(f);
    if (!type) continue;
    let value = '';
    let options = [];
    try {
      if (type === 'text') value = f.getText() || '';
      else if (type === 'check') value = f.isChecked();
      else if (type === 'radio') { value = f.getSelected() || ''; options = f.getOptions(); }
      else { value = f.getSelected()?.[0] || ''; options = f.getOptions(); }
    } catch {}
    const widgets = [];
    for (const w of f.acroField.getWidgets()) {
      const r = w.getRectangle();
      let index = pages.findIndex((pg) => pg.ref === w.P());
      if (index < 0) {
        const wRef = d.context.getObjectRef(w.dict);
        index = pages.findIndex((pg) => pg.node.Annots()?.asArray().includes(wRef));
      }
      // Em grupos de opção, cada widget é uma opção (o valor "ligado" do widget)
      let option = null;
      if (type === 'radio') option = w.getOnValue?.()?.decodeText?.() ?? null;
      if (index >= 0) widgets.push({ index, rect: [r.x, r.y, r.x + r.width, r.y + r.height], option });
    }
    fields.push({ name: f.getName(), type, value, options, readOnly: f.isReadOnly?.() || false, widgets });
  }
  return { fields };
}

function applyFormValues(out, values) {
  let form;
  try { form = out.getForm(); } catch { return; }
  for (const [name, value] of values) {
    const f = form.getFieldMaybe(name);
    if (!f) continue;
    try {
      const type = fieldType(f);
      if (type === 'text') f.setText(String(value));
      else if (type === 'check') { if (value) f.check(); else f.uncheck(); }
      else if (type === 'radio') { if (value) f.select(value); else f.clear(); }
      else if (type === 'dropdown' || type === 'list') { if (value) f.select(value); else f.clear(); }
    } catch (err) { console.warn('campo', name, err); }
  }
}

// Campos criados no app (retângulos kind field-*) viram campos de formulário de verdade
async function addNewFields(out, outPage, viewport, objects) {
  const list = (objects || []).filter((o) => FIELD_KINDS.has(o.kind) && o.fieldName);
  if (!list.length) return;
  const form = out.getForm();
  const toPdf = inv(viewport.transform);
  for (const obj of await fabric.util.enlivenObjects(list)) {
    obj.setCoords();
    const pts = Object.values(obj.aCoords).map(({ x, y }) => [toPdf[0] * x + toPdf[2] * y + toPdf[4], toPdf[1] * x + toPdf[3] * y + toPdf[5]]);
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), borderWidth: 1 };
    let name = obj.fieldName;
    for (let n = 2; form.getFieldMaybe(name); n++) name = `${obj.fieldName} ${n}`;
    if (obj.kind === 'field-check') form.createCheckBox(name).addToPage(outPage, box);
    else {
      const tf = form.createTextField(name);
      tf.addToPage(outPage, box);
      tf.setFontSize(0); // tamanho automático
    }
  }
}

export async function blankPdf(width = 595.28, height = 841.89) {
  const d = await PDFDocument.create();
  d.addPage([width, height]);
  return d.save();
}

// doc: { sources: Map(id -> { bytes, pdf }), pages: [{ src, index, rotate, objects }] }
// Tarja (preta) e cobrir (branca) apagam de verdade o que fica embaixo: texto, imagens e traços cobertos.
// O motor apaga no PDF de origem; depois a tarja é desenhada por cima como as outras anotações.
const REDACT_KINDS = { cover: 'all', redact: 'all', 'edit-cover': 'text', 'ocr-cover': 'art' }; // ocr-cover: palavra desenhada (Editar frase via OCR)
const BOX_KINDS = new Set(['cover', 'redact', 'edit-cover', 'ocr-cover', 'highlight', 'underline', 'strike']);
const FIELD_KINDS = new Set(['field-text', 'field-check']);

async function viewportOf(doc, p) {
  const pdfjsPage = await doc.sources.get(p.src).pdf.getPage(p.index + 1);
  return pdfjsPage.getViewport({ scale: 1, rotation: (pdfjsPage.rotate + p.rotate) % 360 });
}

// Devolve, para cada página, a chave do arquivo de origem e os bytes de cada chave (já com a redação aplicada)
async function redactSources(doc) {
  const keys = doc.pages.map((p) => p.src);
  const bytes = new Map([...new Set(keys)].map((id) => [id, doc.sources.get(id).bytes]));
  const uses = new Map();
  doc.pages.forEach((p) => uses.set(`${p.src}:${p.index}`, (uses.get(`${p.src}:${p.index}`) || 0) + 1));
  const jobs = new Map(); // chave -> [{ index, rects }]
  for (const [i, p] of doc.pages.entries()) {
    const boxes = (p.objects || []).filter((o) => REDACT_KINDS[o.kind] && o.visible !== false);
    if (!boxes.length) continue;
    const toPdf = inv((await viewportOf(doc, p)).transform);
    const rects = [];
    for (const obj of await fabric.util.enlivenObjects(boxes)) {
      const mode = REDACT_KINDS[obj.kind];
      // a cobertura de "Editar frase" é um pouco maior que a frase; encolhe para não pegar a linha vizinha
      const w = obj.width / 2;
      const hh = obj.height / 2 - (mode === 'text' ? obj.height * 0.14 : 0);
      const m = obj.calcTransformMatrix();
      const quad = [[-w, -hh], [w, -hh], [w, hh], [-w, hh]].flatMap(([x, y]) => {
        const q = fabric.util.transformPoint(new fabric.Point(x, y), m);
        return [toPdf[0] * q.x + toPdf[2] * q.y + toPdf[4], toPdf[1] * q.x + toPdf[3] * q.y + toPdf[5]];
      });
      rects.push({ quad, mode });
    }
    // Página usada mais de uma vez: a cópia com tarja ganha um arquivo só dela
    let key = p.src;
    if (uses.get(`${p.src}:${p.index}`) > 1) {
      key = `${p.src}#${i}`;
      keys[i] = key;
      bytes.set(key, doc.sources.get(p.src).bytes);
    }
    if (!jobs.has(key)) jobs.set(key, []);
    jobs.get(key).push({ index: p.index, rects });
  }
  for (const [key, pages] of jobs) bytes.set(key, (await engine('redact', { bytes: bytes.get(key).slice(), pages })).bytes);
  return { keys, bytes };
}

export async function buildPdf(doc) {
  const { keys, bytes } = await redactSources(doc);
  const libDocs = new Map();
  for (const [key, b] of bytes) libDocs.set(key, await PDFDocument.load(b, { updateMetadata: false }));

  // Base = o primeiro arquivo; assim formulários, marcadores e metadados dele são preservados
  const baseId = keys[0];
  const out = libDocs.get(baseId);
  const baseOriginal = out.getPages();
  const wanted = [];
  for (const [i, p] of doc.pages.entries()) {
    if (keys[i] === baseId) wanted.push(baseOriginal[p.index]);
    else {
      const [copy] = await out.copyPages(libDocs.get(keys[i]), [p.index]);
      wanted.push(copy);
    }
  }
  // Uma página da base só pode entrar uma vez; se repetir, entra como cópia
  const used = new Set();
  for (let i = 0; i < wanted.length; i++) {
    if (used.has(wanted[i])) [wanted[i]] = await out.copyPages(out, [baseOriginal.indexOf(wanted[i])]);
    used.add(wanted[i]);
  }
  for (let i = out.getPageCount() - 1; i >= 0; i--) out.removePage(i);
  for (const pg of wanted) out.addPage(pg);

  const fontOf = standardFonts(out);
  if (doc.formValues?.size && doc.form?.src === doc.pages[0].src && keys[0] === doc.pages[0].src) applyFormValues(out, doc.formValues);
  const fields = formWidgets(out);
  for (let i = 0; i < doc.pages.length; i++) {
    const p = doc.pages[i];
    const pdfjsPage = await doc.sources.get(p.src).pdf.getPage(p.index + 1);
    const total = (pdfjsPage.rotate + p.rotate) % 360;
    const outPage = out.getPage(i);
    outPage.setRotation(degrees(total));
    const viewport = pdfjsPage.getViewport({ scale: 1, rotation: total });
    const onPage = fields.filter((f) => f.pageRef === outPage.ref);
    const fill = (text, [x, y]) => {
      // Caixas de marcar são pequenas: aceita um X tocado um pouco ao lado
      const tol = (f) => (f.field instanceof PDFCheckBox ? 9 : 0);
      const hit = onPage.find((f) => x >= f.x0 - tol(f) && x <= f.x1 + tol(f) && y >= f.y0 - tol(f) && y <= f.y1 + tol(f));
      if (!hit) return false;
      try {
        if (hit.field instanceof PDFTextField) { hit.field.setText(text); return true; }
        if (hit.field instanceof PDFCheckBox && /^\s*[xX✓✔]\s*$/.test(text)) { hit.field.check(); return true; }
      } catch {}
      return false;
    };
    await stampPage(out, outPage, viewport, p.objects, fontOf, fill);
    await addNewFields(out, outPage, viewport, p.objects);
  }
  out.setProducer('Editor PDF (CyberSecInfo)');
  out.setModificationDate(new Date());
  return out.save({ useObjectStreams: true });
}

export async function mergePdfs(list) {
  const out = await PDFDocument.create();
  for (const bytes of list) {
    const src = await PDFDocument.load(bytes, { updateMetadata: false });
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  out.setProducer('Editor PDF (CyberSecInfo)');
  return out.save({ useObjectStreams: true });
}

// Cada imagem vira uma página A4 (retrato ou paisagem, conforme a foto), com margem
export async function imagesToPdf(files) {
  const out = await PDFDocument.create();
  const A4 = [595.28, 841.89];
  const M = 24;
  for (const file of files) {
    const bmp = await createImageBitmap(file);
    const max = 2400;
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const jpg = await out.embedJpg(c.toDataURL('image/jpeg', 0.88));
    const landscape = c.width > c.height;
    const [pw, ph] = landscape ? [A4[1], A4[0]] : A4;
    const s = Math.min((pw - 2 * M) / c.width, (ph - 2 * M) / c.height);
    const page = out.addPage([pw, ph]);
    page.drawImage(jpg, { x: (pw - c.width * s) / 2, y: (ph - c.height * s) / 2, width: c.width * s, height: c.height * s });
  }
  out.setProducer('Editor PDF (CyberSecInfo)');
  return out.save({ useObjectStreams: true });
}
