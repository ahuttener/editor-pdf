// Monta o PDF final: parte do arquivo original, aplica formulário, desenha as edições
// como conteúdo vetorial (texto de verdade, retângulos, imagens) e reorganiza as páginas.
import { fabric, PDFLib, fontkit, TEXT_BASELINE_RATIO, lineAdvance } from './libs.js';
import { applyFormValues } from './forms.js';

const { PDFDocument, StandardFonts, BlendMode, degrees, rgb } = PDFLib;

function parseColor(value) {
  if (!value || value === 'transparent' || typeof value !== 'string') return null;
  const c = new fabric.Color(value);
  const [r, g, b, a] = c.getSource();
  return { color: rgb(r / 255, g / 255, b / 255), alpha: a ?? 1 };
}

// Cache de fontes embutidas no documento de saída
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

// Remove caracteres que a fonte não consegue codificar (só acontece no fallback Helvetica)
function encodableText(font, text) {
  try { font.encodeText(text); return text; } catch { /* filtra abaixo */ }
  return [...text].map((ch) => { try { font.encodeText(ch); return ch; } catch { return '?'; } }).join('');
}

function isBold(obj) {
  const w = obj.fontWeight;
  return w === 'bold' || w === 'bolder' || (Number(w) || 0) >= 600;
}

export async function buildPdf(state, getFontBytes) {
  const main = state.docs.get('main');
  const out = await PDFDocument.load(main.bytes, { updateMetadata: false });
  out.registerFontkit(fontkit);
  const fontFor = makeFontProvider(out, getFontBytes);

  await applyFormValues(out, state.formFields, () => fontFor('Arial', false, false));

  const mainPages = out.getPages();
  const copied = new Map();
  async function pdfPageFor(entry) {
    if (entry.docKey === 'main') return mainPages[entry.index];
    if (!copied.has(entry.docKey)) {
      const src = await PDFDocument.load(state.docs.get(entry.docKey).bytes, { updateMetadata: false });
      copied.set(entry.docKey, await out.copyPages(src, src.getPageIndices()));
    }
    return copied.get(entry.docKey)[entry.index];
  }

  const imageCache = new Map();
  const finalPages = [];
  for (const entry of state.pages) {
    const page = await pdfPageFor(entry);
    const rotation = entry.rotation();
    await drawOverlay({ out, page, entry, viewport: entry.viewport(), rotation, fontFor, imageCache });
    page.setRotation(degrees(rotation));
    finalPages.push(page);
  }

  while (out.getPageCount() > 0) out.removePage(0);
  for (const page of finalPages) out.addPage(page);

  return out.save({ useObjectStreams: true });
}

async function drawOverlay({ out, page, entry, viewport, rotation, fontFor, imageCache }) {
  const canvas = entry.fabric;
  if (!canvas) return;
  const objects = canvas.getObjects().filter((o) => o.visible !== false);
  if (!objects.length) return;

  // Converte um ponto local do objeto (origem no centro dele) para coordenadas do PDF
  const toPdf = (obj, x, y) => {
    const p = fabric.util.transformPoint(new fabric.Point(x, y), obj.calcTransformMatrix());
    const [px, py] = viewport.convertToPdfPoint(p.x, p.y);
    return { x: px, y: py };
  };
  // Ângulo no PDF (anti-horário) = rotação da página − ângulo do objeto na tela (horário)
  const pdfAngle = (obj) => degrees(rotation - (obj.getTotalAngle ? obj.getTotalAngle() : obj.angle || 0));

  let rasterDrawn = false;
  for (const obj of objects) {
    if (obj instanceof fabric.IText) {
      await drawText(page, obj, toPdf, pdfAngle, fontFor);
    } else if (obj instanceof fabric.FabricImage) {
      await drawImage(out, page, obj, toPdf, pdfAngle, imageCache);
    } else if (obj instanceof fabric.Rect) {
      drawRect(page, obj, toPdf, pdfAngle);
    } else if (!rasterDrawn) {
      // Traços à mão livre (e qualquer outro tipo) viram uma imagem transparente da página
      rasterDrawn = true;
      const others = objects.filter((o) => !(o instanceof fabric.IText || o instanceof fabric.FabricImage || o instanceof fabric.Rect));
      await drawRaster(out, page, others, viewport, rotation);
    }
  }
}

async function drawText(page, obj, toPdf, pdfAngle, fontFor) {
  const lines = obj.textLines || String(obj.text || '').split('\n');
  const colorInfo = parseColor(obj.fill) || { color: rgb(0, 0, 0), alpha: 1 };
  const font = await fontFor(obj.fontFamily, isBold(obj), obj.fontStyle === 'italic' || obj.fontStyle === 'oblique');
  const size = obj.fontSize * (obj.scaleY || 1);
  const left = -obj.width / 2;
  const top = -obj.height / 2;
  const rotate = pdfAngle(obj);
  lines.forEach((line, i) => {
    if (!line || !line.trim()) return;
    const offset = obj._getLineLeftOffset ? obj._getLineLeftOffset(i) : 0;
    const baseline = top + i * lineAdvance(obj) + obj.fontSize * TEXT_BASELINE_RATIO;
    const p = toPdf(obj, left + offset, baseline);
    page.drawText(encodableText(font, line), {
      x: p.x,
      y: p.y,
      size,
      font,
      color: colorInfo.color,
      opacity: colorInfo.alpha * (obj.opacity ?? 1),
      rotate,
    });
  });
}

function drawRect(page, obj, toPdf, pdfAngle) {
  const fill = parseColor(obj.fill);
  const stroke = obj.strokeWidth > 0 ? parseColor(obj.stroke) : null;
  if (!fill && !stroke) return;
  const p = toPdf(obj, -obj.width / 2, obj.height / 2); // canto inferior esquerdo
  const scale = obj.scaleY || 1;
  const options = {
    x: p.x,
    y: p.y,
    width: obj.width * (obj.scaleX || 1),
    height: obj.height * scale,
    rotate: pdfAngle(obj),
  };
  if (fill) {
    options.color = fill.color;
    options.opacity = fill.alpha * (obj.opacity ?? 1);
  }
  if (stroke) {
    options.borderColor = stroke.color;
    options.borderWidth = obj.strokeWidth * scale;
    options.borderOpacity = stroke.alpha * (obj.opacity ?? 1);
  }
  if (obj.kind === 'highlight') options.blendMode = BlendMode.Multiply;
  page.drawRectangle(options);
}

async function drawImage(out, page, obj, toPdf, pdfAngle, imageCache) {
  const src = obj.getSrc();
  if (!imageCache.has(src)) {
    imageCache.set(src, src.startsWith('data:image/png') ? out.embedPng(src) : out.embedJpg(src));
  }
  const image = await imageCache.get(src);
  const p = toPdf(obj, -obj.width / 2, obj.height / 2);
  page.drawImage(image, {
    x: p.x,
    y: p.y,
    width: obj.width * (obj.scaleX || 1),
    height: obj.height * (obj.scaleY || 1),
    rotate: pdfAngle(obj),
    opacity: obj.opacity ?? 1,
  });
}

async function drawRaster(out, page, objects, viewport, rotation) {
  const temp = new fabric.StaticCanvas(undefined, {
    width: viewport.width,
    height: viewport.height,
    enableRetinaScaling: false,
    renderOnAddRemove: false,
  });
  for (const obj of objects) temp.add(await obj.clone());
  temp.renderAll();
  const dataUrl = temp.toDataURL({ format: 'png', multiplier: 3 });
  temp.dispose();
  const image = await out.embedPng(dataUrl);
  const [x, y] = viewport.convertToPdfPoint(0, viewport.height);
  page.drawImage(image, { x, y, width: viewport.width, height: viewport.height, rotate: degrees(rotation) });
}
