// Monta o PDF final: parte dos arquivos originais (já com a redação aplicada pelo motor),
// aplica formulário, desenha as edições como conteúdo vetorial (texto de verdade, retângulos,
// linhas, elipses, imagens), grava as notas como comentários do PDF e reorganiza as páginas.
import { fabric, PDFLib, fontkit, TEXT_BASELINE_RATIO, lineAdvance } from './libs.js';
import { applyFormValues } from './forms.js';

const { PDFDocument, StandardFonts, BlendMode, LineCapStyle, PDFHexString, PDFString, degrees, rgb } = PDFLib;

// cover = fundo da frase editada (só o texto sai, para não apagar linhas de tabela etc.);
// whiteout e redact apagam texto, imagens e desenhos embaixo
const REDACT_KINDS = { cover: 'text', whiteout: 'all', redact: 'all' };

function parseColor(value) {
  if (!value || value === 'transparent' || typeof value !== 'string') return null;
  const c = new fabric.Color(value);
  const [r, g, b, a] = c.getSource();
  if ((a ?? 1) === 0) return null;
  return { color: rgb(r / 255, g / 255, b / 255), alpha: a ?? 1 };
}

// Converte um ponto local do objeto (origem no centro dele) para o espaço da página do PDF
function makeToPdf(viewport) {
  return (obj, x, y) => {
    const p = fabric.util.transformPoint(new fabric.Point(x, y), obj.calcTransformMatrix());
    const [px, py] = viewport.convertToPdfPoint(p.x, p.y);
    return { x: px, y: py };
  };
}

// Áreas que o motor deve apagar de verdade antes de montar o PDF.
// Devolve trabalhos { sourceKey, docKey, pages }: páginas usadas uma vez são agrupadas por documento;
// páginas duplicadas ganham uma cópia própria do documento (sourceKey "entry:<id>"),
// para a tarja de uma cópia não afetar a outra.
export async function collectRedactions(state) {
  const uses = new Map();
  for (const e of state.pages) uses.set(`${e.docKey}:${e.index}`, (uses.get(`${e.docKey}:${e.index}`) || 0) + 1);
  const byDoc = new Map();
  const jobs = [];
  for (const entry of state.pages) {
    const toPdf = makeToPdf(entry.viewport());
    const rects = [];
    for (const obj of await entry.objects()) {
      const mode = REDACT_KINDS[obj.kind];
      if (!mode || obj.visible === false) continue;
      // a cobertura de "Editar texto" é um pouco maior que a frase; encolhe para não pegar a linha vizinha
      const insetY = obj.kind === 'cover' ? obj.height * 0.14 : 0;
      const w = obj.width / 2;
      const h = obj.height / 2 - insetY;
      const quad = [[-w, -h], [w, -h], [w, h], [-w, h]].flatMap(([x, y]) => { const p = toPdf(obj, x, y); return [p.x, p.y]; });
      rects.push({ quad, mode });
    }
    if (!rects.length) continue;
    if (uses.get(`${entry.docKey}:${entry.index}`) > 1) {
      jobs.push({ sourceKey: `entry:${entry.id}`, docKey: entry.docKey, pages: [{ index: entry.index, rects }] });
      continue;
    }
    if (!byDoc.has(entry.docKey)) byDoc.set(entry.docKey, []);
    byDoc.get(entry.docKey).push({ index: entry.index, rects });
  }
  for (const [docKey, pages] of byDoc) jobs.unshift({ sourceKey: docKey, docKey, pages });
  return jobs;
}

function makeFontProvider(out, getFontBytes) {
  const cache = new Map();
  return async function fontFor(family, bold, italic) {
    const variant = (bold ? 1 : 0) + (italic ? 2 : 0);
    const key = `${family}|${variant}`;
    if (!cache.has(key)) {
      cache.set(key, (async () => {
        const bytes = await getFontBytes(family, variant);
        if (bytes) {
          try { return await out.embedFont(bytes, { subset: true }); } catch (err) { console.warn('Fonte não embutida', family, err); }
        }
        const std = [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique][variant];
        return out.embedFont(std);
      })());
    }
    return cache.get(key);
  };
}

function encodableText(font, text) {
  try { font.encodeText(text); return text; } catch { /* filtra abaixo */ }
  return [...text].map((ch) => { try { font.encodeText(ch); return ch; } catch { return '?'; } }).join('');
}

const isBold = (o) => o.fontWeight === 'bold' || o.fontWeight === 'bolder' || (Number(o.fontWeight) || 0) >= 600;
const isItalic = (o) => o.fontStyle === 'italic' || o.fontStyle === 'oblique';

// sources: Map docKey (ou "entry:<id>") -> bytes a usar (com redação); se faltar, usa os bytes originais
export async function buildPdf(state, getFontBytes, sources = new Map()) {
  const bytesOf = (key) => sources.get(key) || state.docs.get(key).bytes;
  const out = await PDFDocument.load(bytesOf('main'), { updateMetadata: false });
  out.registerFontkit(fontkit);
  const fontFor = makeFontProvider(out, getFontBytes);

  await applyFormValues(out, state.formFields, () => fontFor('Arial', false, false));
  applyMetadata(out, state.meta);

  const mainPages = out.getPages();
  const loaded = new Map();
  const used = new Set();
  const loadSrc = async (key) => {
    if (!loaded.has(key)) loaded.set(key, PDFDocument.load(bytesOf(key), { updateMetadata: false }));
    return loaded.get(key);
  };
  async function pdfPageFor(entry) {
    const own = sources.get(`entry:${entry.id}`);
    if (own) {
      const src = await PDFDocument.load(own, { updateMetadata: false });
      const [page] = await out.copyPages(src, [entry.index]);
      return page;
    }
    const id = `${entry.docKey}:${entry.index}`;
    const first = !used.has(id);
    used.add(id);
    if (entry.docKey === 'main' && first) return mainPages[entry.index];
    const src = await loadSrc(entry.docKey);
    const [page] = await out.copyPages(src, [entry.index]);
    return page;
  }

  const imageCache = new Map();
  const finalPages = [];
  const made = { fields: 0 };
  for (const entry of state.pages) {
    const page = await pdfPageFor(entry);
    const rotation = entry.rotation();
    await drawOverlay({ out, page, entry, viewport: entry.viewport(), rotation, fontFor, imageCache, author: state.meta?.author, made });
    page.setRotation(degrees(rotation));
    finalPages.push(page);
  }

  if (made.fields) out.getForm().updateFieldAppearances(await fontFor('Arial', false, false));

  while (out.getPageCount() > 0) out.removePage(0);
  for (const page of finalPages) out.addPage(page);

  return out.save({ useObjectStreams: true });
}

function applyMetadata(out, meta) {
  if (!meta) return;
  if (meta.title !== undefined) out.setTitle(meta.title || '', { showInWindowTitleBar: !!meta.title });
  if (meta.author !== undefined) out.setAuthor(meta.author || '');
  if (meta.subject !== undefined) out.setSubject(meta.subject || '');
  if (meta.keywords !== undefined) out.setKeywords((meta.keywords || '').split(',').map((k) => k.trim()).filter(Boolean));
  if (meta.lang) out.setLanguage(meta.lang);
  out.setProducer('Editor PDF (CyberSecInfo)');
  out.setModificationDate(new Date());
}

async function drawOverlay({ out, page, entry, viewport, rotation, fontFor, imageCache, author, made }) {
  const objects = (await entry.objects()).filter((o) => o.visible !== false);
  if (!objects.length) return;
  const toPdf = makeToPdf(viewport);
  const pdfAngle = (obj) => degrees(rotation - (obj.getTotalAngle ? obj.getTotalAngle() : obj.angle || 0));
  const isVector = (o) => o instanceof fabric.IText || o instanceof fabric.FabricImage || o instanceof fabric.Rect
    || o instanceof fabric.Ellipse || o instanceof fabric.Line || o.kind === 'note' || o.kind === 'field';

  // Desenho livre, setas e carimbos viram imagem transparente da página (alta resolução).
  // Objetos seguidos desse tipo vão juntos numa imagem, respeitando a ordem de empilhamento.
  let batch = [];
  const flush = async () => {
    if (batch.length) await drawRaster(out, page, batch, viewport, rotation);
    batch = [];
  };
  for (const obj of objects) {
    if (!isVector(obj)) { batch.push(obj); continue; }
    await flush();
    if (obj.kind === 'note') addNoteAnnotation(out, page, obj, toPdf, author);
    else if (obj.kind === 'field') { createFormField(out, page, obj, viewport); made.fields++; }
    else if (obj instanceof fabric.IText) await drawText(page, obj, toPdf, pdfAngle, fontFor);
    else if (obj instanceof fabric.FabricImage) await drawImage(out, page, obj, toPdf, pdfAngle, imageCache);
    else if (obj instanceof fabric.Rect) drawRect(page, obj, toPdf, pdfAngle);
    else if (obj instanceof fabric.Ellipse) drawEllipse(page, obj, toPdf, pdfAngle);
    else if (obj instanceof fabric.Line) drawLine(page, obj, toPdf);
  }
  await flush();
}

async function drawText(page, obj, toPdf, pdfAngle, fontFor) {
  const lines = obj.textLines || String(obj.text || '').split('\n');
  const colorInfo = parseColor(obj.fill) || { color: rgb(0, 0, 0), alpha: 1 };
  const font = await fontFor(obj.fontFamily, isBold(obj), isItalic(obj));
  const size = obj.fontSize * (obj.scaleY || 1);
  const left = -obj.width / 2;
  const top = -obj.height / 2;
  const rotate = pdfAngle(obj);
  const opacity = colorInfo.alpha * (obj.opacity ?? 1);
  if (obj.backgroundColor) {
    const bg = parseColor(obj.backgroundColor);
    const p = toPdf(obj, left, -top);
    if (bg) page.drawRectangle({ x: p.x, y: p.y, width: obj.width * (obj.scaleX || 1), height: obj.height * (obj.scaleY || 1), rotate, color: bg.color, opacity: bg.alpha * (obj.opacity ?? 1) });
  }
  lines.forEach((line, i) => {
    if (!line || !line.trim()) return;
    const offset = obj._getLineLeftOffset ? obj._getLineLeftOffset(i) : 0;
    const baseline = top + i * lineAdvance(obj) + obj.fontSize * TEXT_BASELINE_RATIO;
    const p = toPdf(obj, left + offset, baseline);
    page.drawText(encodableText(font, line), { x: p.x, y: p.y, size, font, color: colorInfo.color, opacity, rotate });
    if (obj.underline || obj.linethrough) {
      const width = obj.getLineWidth ? obj.getLineWidth(i) : 0;
      const thickness = Math.max(0.5, size * 0.06);
      const marks = [];
      if (obj.underline) marks.push(baseline + obj.fontSize * 0.12);
      if (obj.linethrough) marks.push(baseline - obj.fontSize * 0.28);
      for (const y of marks) {
        page.drawLine({ start: toPdf(obj, left + offset, y), end: toPdf(obj, left + offset + width, y), thickness, color: colorInfo.color, opacity });
      }
    }
  });
}

function drawRect(page, obj, toPdf, pdfAngle) {
  const fill = parseColor(obj.fill);
  const stroke = obj.strokeWidth > 0 ? parseColor(obj.stroke) : null;
  if (!fill && !stroke) return;
  const p = toPdf(obj, -obj.width / 2, obj.height / 2); // canto inferior esquerdo
  const scale = obj.scaleY || 1;
  const options = { x: p.x, y: p.y, width: obj.width * (obj.scaleX || 1), height: obj.height * scale, rotate: pdfAngle(obj) };
  if (fill) { options.color = fill.color; options.opacity = fill.alpha * (obj.opacity ?? 1); }
  if (stroke) { options.borderColor = stroke.color; options.borderWidth = obj.strokeWidth * scale; options.borderOpacity = stroke.alpha * (obj.opacity ?? 1); }
  if (obj.kind === 'highlight') options.blendMode = BlendMode.Multiply;
  page.drawRectangle(options);
}

function drawEllipse(page, obj, toPdf, pdfAngle) {
  const fill = parseColor(obj.fill);
  const stroke = obj.strokeWidth > 0 ? parseColor(obj.stroke) : null;
  if (!fill && !stroke) return;
  const c = toPdf(obj, 0, 0);
  const options = { x: c.x, y: c.y, xScale: obj.rx * (obj.scaleX || 1), yScale: obj.ry * (obj.scaleY || 1), rotate: pdfAngle(obj) };
  if (fill) { options.color = fill.color; options.opacity = fill.alpha * (obj.opacity ?? 1); }
  if (stroke) { options.borderColor = stroke.color; options.borderWidth = obj.strokeWidth * (obj.scaleY || 1); options.borderOpacity = stroke.alpha * (obj.opacity ?? 1); }
  page.drawEllipse(options);
}

function drawLine(page, obj, toPdf) {
  const stroke = parseColor(obj.stroke);
  if (!stroke) return;
  const { x1, y1, x2, y2 } = obj.calcLinePoints();
  page.drawLine({
    start: toPdf(obj, x1, y1),
    end: toPdf(obj, x2, y2),
    thickness: obj.strokeWidth * (obj.scaleY || 1),
    color: stroke.color,
    opacity: stroke.alpha * (obj.opacity ?? 1),
    lineCap: LineCapStyle.Round,
    ...(obj.kind === 'highlight' ? { blendMode: BlendMode.Multiply } : {}),
  });
}

async function drawImage(out, page, obj, toPdf, pdfAngle, imageCache) {
  const src = obj.getSrc();
  if (!imageCache.has(src)) {
    imageCache.set(src, src.startsWith('data:image/png') ? out.embedPng(src) : out.embedJpg(src));
  }
  const image = await imageCache.get(src);
  const p = toPdf(obj, -obj.width / 2, obj.height / 2);
  page.drawImage(image, {
    x: p.x, y: p.y,
    width: obj.width * (obj.scaleX || 1), height: obj.height * (obj.scaleY || 1),
    rotate: pdfAngle(obj), opacity: obj.opacity ?? 1,
  });
}

// Campo de formulário criado no editor vira campo de verdade do PDF (preenchível em qualquer leitor)
function createFormField(out, page, obj, viewport) {
  const f = obj.field || {};
  const pts = obj.getCoords().map((p) => viewport.convertToPdfPoint(p.x, p.y));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  const look = { ...box, borderWidth: 1, borderColor: rgb(0.55, 0.6, 0.7), backgroundColor: rgb(1, 1, 1) };
  const form = out.getForm();
  const base = String(f.name || 'campo').trim();
  let name = base;
  for (let k = 2; ; k++) {
    let exists = true;
    try { form.getField(name); } catch { exists = false; }
    if (!exists) break;
    name = `${base}_${k}`;
  }
  let field;
  if (f.type === 'check') {
    field = form.createCheckBox(name);
    field.addToPage(page, look);
  } else if (f.type === 'list') {
    field = form.createDropdown(name);
    field.addOptions((f.options || []).filter(Boolean));
    field.addToPage(page, look);
  } else {
    field = form.createTextField(name);
    if (f.multiline) field.enableMultiline();
    field.addToPage(page, look);
  }
  if (f.required) field.enableRequired();
}

// Nota = comentário de verdade do PDF (ícone + texto), visível no Acrobat, Edge, Chrome etc.
function addNoteAnnotation(out, page, obj, toPdf, author) {
  const text = String(obj.text || '').trim();
  if (!text) return;
  const p = toPdf(obj, -obj.width / 2, -obj.height / 2); // canto superior esquerdo
  const annot = out.context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [p.x, p.y - 22, p.x + 22, p.y],
    Contents: PDFHexString.fromText(text),
    T: PDFHexString.fromText(author || 'Comentário'),
    M: PDFString.fromDate(new Date()),
    Name: 'Comment',
    C: [1, 0.85, 0.15],
    F: 4,
    Open: false,
  });
  page.node.addAnnot(out.context.register(annot));
}

async function drawRaster(out, page, objects, viewport, rotation) {
  if (!objects.length) return;
  const temp = new fabric.StaticCanvas(undefined, { width: viewport.width, height: viewport.height, enableRetinaScaling: false, renderOnAddRemove: false });
  for (const obj of objects) temp.add(await obj.clone());
  temp.renderAll();
  const dataUrl = temp.toDataURL({ format: 'png', multiplier: 3 });
  temp.dispose();
  const image = await out.embedPng(dataUrl);
  const [x, y] = viewport.convertToPdfPoint(0, viewport.height);
  page.drawImage(image, { x, y, width: viewport.width, height: viewport.height, rotate: degrees(rotation) });
}

// Permissões do PDF (/P) a partir das opções do diálogo de senha
export function permissionsFrom(p) {
  let bits = -4; // tudo liberado
  if (p.noPrint) bits &= ~(4 | 2048);
  if (p.noCopy) bits &= ~16;
  if (p.noEdit) bits &= ~(8 | 32 | 1024);
  return bits;
}
