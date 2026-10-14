// Leitura (pdf.js), gravação (pdf-lib) e as ferramentas de documento inteiro (juntar, imagens em PDF).
import * as pdfjs from 'pdfjs-dist/build/pdf.min.mjs';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, PDFTextField, PDFCheckBox, StandardFonts, rgb, degrees, pushGraphicsState, popGraphicsState, concatTransformationMatrix } from 'pdf-lib';
import { fabric, TEXT_BASELINE_RATIO, LINE_MULT } from './fabric-setup.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
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
async function stampPage(outDoc, outPage, viewport, objects, font, fill = () => false) {
  if (!objects?.length) return;
  const W = viewport.width;
  const H = viewport.height;
  const toPdf = mul([1, 0, 0, -1, 0, H], inv(viewport.transform));

  const texts = [];
  const raster = [];
  const boxes = []; // tarja e marca-texto sem giro: retângulo vetorial (em PNG a borda fica com halo cinza)
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
    if (o.type?.toLowerCase().includes('text') && o.text) {
      try { font.encodeText(o.text.replace(/\n/g, '')); texts.push(o); } catch { raster.push(o); }
    } else if ((o.kind === 'cover' || o.kind === 'highlight') && !(o.angle % 360) && typeof o.fill === 'string') boxes.push(o);
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
      obj.text.split('\n').forEach((line, i) => {
        if (!line) return;
        const by = i * size * LINE_MULT * obj.lineHeight + size * TEXT_BASELINE_RATIO;
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

// doc: { sources: Map(id -> { bytes, pdf }), pages: [{ src, index, rotate, objects }] }
export async function buildPdf(doc) {
  const srcIds = [...new Set(doc.pages.map((p) => p.src))];
  const libDocs = new Map();
  for (const id of srcIds) libDocs.set(id, await PDFDocument.load(doc.sources.get(id).bytes, { updateMetadata: false }));

  // Base = o primeiro arquivo; assim formulários, marcadores e metadados dele são preservados
  const baseId = doc.pages[0].src;
  const out = libDocs.get(baseId);
  const baseOriginal = out.getPages();
  const wanted = [];
  for (const p of doc.pages) {
    if (p.src === baseId) wanted.push(baseOriginal[p.index]);
    else {
      const [copy] = await out.copyPages(libDocs.get(p.src), [p.index]);
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

  const font = await out.embedFont(StandardFonts.Helvetica);
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
    await stampPage(out, outPage, viewport, p.objects, font, fill);
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
