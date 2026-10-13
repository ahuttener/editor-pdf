// Operações do motor PDF (MuPDF + Tesseract): senha/criptografia, redação (apagar de verdade),
// compressão, exportação de páginas como imagem, texto com estilo e OCR.
import * as mupdf from 'mupdf';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { createWorker } from 'tesseract.js';
import * as docx from 'docx';
import fs from 'node:fs/promises';

const config = { tessdata: null, tessCache: null, ocrFont: null };
export function configure(values) { Object.assign(config, values); }

const open = (bytes) => mupdf.Document.openDocument(bytes, 'application/pdf').asPDF();
const save = (doc, options = '') => new Uint8Array(doc.saveToBuffer(options).asUint8Array());

function encryptInfo(doc) {
  const enc = doc.getTrailer().get('Encrypt');
  if (!enc || enc.isNull()) return null;
  const p = enc.get('P');
  return { permissions: p && !p.isNull() ? p.valueOf() : -4 };
}

export const ops = {
  inspect({ bytes }) {
    const doc = open(bytes);
    const encrypted = !!encryptInfo(doc);
    const needsPassword = doc.needsPassword();
    let canEdit = true;
    if (!needsPassword) canEdit = doc.hasPermission('edit') && doc.hasPermission('annotate');
    return { encrypted, needsPassword, canEdit, pages: needsPassword ? 0 : doc.countPages() };
  },

  // Autentica e devolve uma cópia sem criptografia para o editor trabalhar
  unlock({ bytes, password }) {
    const doc = open(bytes);
    const info = encryptInfo(doc);
    const level = doc.authenticatePassword(password ?? '');
    if (level === 0) return { ok: false, reason: 'wrong' };
    const owner = (level & 4) !== 0;
    const canEdit = owner || (doc.hasPermission('edit') && doc.hasPermission('annotate'));
    if (!canEdit) return { ok: false, reason: 'restricted', level };
    return { ok: true, level, owner, permissions: info?.permissions ?? -4, bytes: save(doc, 'encrypt=none') };
  },

  // pages: [{ index, rects: [{ quad: [x0,y0,x1,y1,x2,y2,x3,y3] (espaço do PDF), mode: 'text'|'all' }] }]
  redact({ bytes, pages }) {
    const doc = open(bytes);
    for (const { index, rects } of pages) {
      const page = doc.loadPage(index);
      const m = page.getTransform();
      for (const mode of ['text', 'all']) {
        const group = rects.filter((r) => r.mode === mode);
        if (!group.length) continue;
        for (const r of group) {
          const xs = [];
          const ys = [];
          for (let i = 0; i < 8; i += 2) {
            const px = r.quad[i];
            const py = r.quad[i + 1];
            xs.push(m[0] * px + m[2] * py + m[4]);
            ys.push(m[1] * px + m[3] * py + m[5]);
          }
          const annot = page.createAnnotation('Redact');
          annot.setRect([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
        }
        if (mode === 'text') {
          page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
        } else {
          page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_PIXELS, mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, mupdf.PDFPage.REDACT_TEXT_REMOVE);
        }
      }
    }
    return { bytes: save(doc) };
  },

  // Último passo do salvar: senha, limpeza de metadados e compactação
  finalize({ bytes, encrypt, sanitize }) {
    const doc = open(bytes);
    const opts = ['garbage=compact', 'compress'];
    if (sanitize) {
      opts.push('sanitize', 'clean');
      for (const key of ['info:Author', 'info:Creator', 'info:Producer', 'info:Subject', 'info:Keywords']) doc.setMetaData(key, '');
    }
    if (encrypt) {
      // as opções do MuPDF são separadas por vírgula: uma vírgula na senha cortaria a senha
      if (/[,]/.test(`${encrypt.user || ''}${encrypt.owner || ''}`)) throw new Error('A senha não pode ter vírgula. Defina outra em Proteger → Senha e permissões.');
      if (encrypt.permissions !== undefined && !Number.isInteger(encrypt.permissions)) throw new Error('permissões inválidas');
      opts.push('encrypt=aes-256', `user-password=${encrypt.user || ''}`, `owner-password=${encrypt.owner || encrypt.user || ''}`);
      if (encrypt.permissions !== undefined) opts.push(`permissions=${encrypt.permissions}`);
    }
    return { bytes: save(doc, opts.join(',')) };
  },

  // level: 'low' | 'medium' | 'high' -> resolução máxima e qualidade das imagens
  compress({ bytes, level }) {
    const cfg = { low: { maxSide: 2400, quality: 85 }, medium: { maxSide: 1600, quality: 72 }, high: { maxSide: 1000, quality: 55 } }[level] || { maxSide: 1600, quality: 72 };
    const doc = open(bytes);
    const count = doc.countObjects();
    let images = 0;
    let rewritten = 0;
    // máscaras (SMask/Mask) precisam continuar em tons de cinza e no tamanho original
    const masks = new Set();
    for (let num = 1; num < count; num++) {
      let o;
      try { o = doc.newIndirect(num, 0); } catch { continue; }
      if (!o.isStream() || o.get('Subtype').toString() !== '/Image') continue;
      for (const key of ['SMask', 'Mask']) {
        const m = o.get(key);
        if (m && m.isIndirect && m.isIndirect()) masks.add(m.asIndirect());
      }
    }
    for (let num = 1; num < count; num++) {
      if (masks.has(num)) continue;
      let obj;
      try { obj = doc.newIndirect(num, 0); } catch { continue; }
      if (!obj || !obj.isStream() || obj.get('Subtype').toString() !== '/Image') continue;
      if (obj.get('ImageMask').valueOf() === true) continue;
      if (!obj.get('SMask').isNull() || !obj.get('Mask').isNull()) continue; // transparência: mantém como está
      images++;
      try {
        const image = doc.loadImage(obj);
        const w = image.getWidth();
        const h = image.getHeight();
        const scale = Math.min(1, cfg.maxSide / Math.max(w, h));
        const filter = obj.get('Filter').toString();
        if (scale >= 1 && filter === '/DCTDecode') continue; // já é JPEG e não é grande
        const tw = Math.max(1, Math.round(w * scale));
        const th = Math.max(1, Math.round(h * scale));
        const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, tw, th], false);
        pix.clear(255);
        const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
        dev.fillImage(image, [tw, 0, 0, th, 0, 0], 1, {});
        dev.close();
        const jpeg = pix.asJPEG(cfg.quality, false);
        const before = obj.readRawStream().getLength();
        if (jpeg.length >= before) continue;
        obj.writeRawStream(jpeg);
        obj.put('Filter', doc.newName('DCTDecode'));
        obj.delete('DecodeParms');
        obj.delete('Decode');
        obj.put('Width', tw);
        obj.put('Height', th);
        obj.put('BitsPerComponent', 8);
        obj.put('ColorSpace', doc.newName('DeviceRGB'));
        rewritten++;
      } catch { /* imagem que o MuPDF não decodifica fica como está */ }
    }
    try { doc.subsetFonts(); } catch { /* opcional */ }
    const out = save(doc, 'garbage=deduplicate,compress,compress-images,compress-fonts');
    return { bytes: out, images, rewritten };
  },

  renderPages({ bytes, dpi, format, pages }) {
    const doc = open(bytes);
    const wanted = (dpi || 150) / 72;
    const list = pages?.length ? pages : [...Array(doc.countPages()).keys()];
    const out = [];
    for (const i of list) {
      const page = doc.loadPage(i);
      const scale = safeScale(page, wanted);
      const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
      out.push(format === 'jpg' ? new Uint8Array(pix.asJPEG(90, false)) : new Uint8Array(pix.asPNG()));
    }
    return { images: out };
  },

  // Texto com posição e estilo, para exportar para Word e .txt
  structuredText({ bytes }) {
    const doc = open(bytes);
    const result = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      const st = page.toStructuredText('preserve-whitespace');
      result.push({ json: st.asJSON(), text: st.asText(), bounds: page.getBounds() });
    }
    return { pages: result };
  },

  // OCR: reconhece o texto das páginas escaneadas e grava uma camada de texto invisível
  // (o PDF fica pesquisável, copiável e editável com "Editar texto")
  async ocr({ bytes, pages, force }, progress) {
    const doc = open(bytes);
    const total = doc.countPages();
    const list = pages?.length ? pages : [...Array(total).keys()];
    const wanted = 300 / 72;
    const found = [];
    let done = 0;
    for (const index of list) {
      done++;
      progress?.({ message: 'Lendo página {n} ({i} de {total})…', vars: { n: index + 1, i: done, total: list.length } });
      const page = doc.loadPage(index);
      if (!force && page.toStructuredText().asText().replace(/\s+/g, '').length > 25) continue; // já tem texto
      const scale = safeScale(page, wanted);
      const pageInv = invert(page.getTransform());
      const tess = await getTesseract();
      // Tenta a orientação normal; se a leitura vier ruim, testa a página girada (escaneamento de lado)
      let best = null;
      for (const angle of [0, 90, 270, 180]) {
        const matrix = mupdf.Matrix.concat(mupdf.Matrix.scale(scale, scale), mupdf.Matrix.rotate(angle));
        const pix = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
        const { data } = await tess.recognize(Buffer.from(pix.asPNG()), {}, { blocks: true });
        if (!best || data.confidence > best.data.confidence) best = { data, matrix, x: pix.getX(), y: pix.getY() };
        if (data.confidence >= 80) break;
      }
      const { data } = best;
      const renderInv = invert(best.matrix);
      const toUser = (px, py) => {
        const dx = px + best.x;
        const dy = py + best.y;
        const fx = renderInv[0] * dx + renderInv[2] * dy + renderInv[4];
        const fy = renderInv[1] * dx + renderInv[3] * dy + renderInv[5];
        return [pageInv[0] * fx + pageInv[2] * fy + pageInv[4], pageInv[1] * fx + pageInv[3] * fy + pageInv[5]];
      };
      const words = [];
      for (const block of data.blocks || []) for (const para of block.paragraphs) for (const line of para.lines) for (const w of line.words) {
        if (!w.text.trim() || w.confidence < 30) continue;
        const b = w.bbox;
        const base = w.baseline && w.baseline.y0 > b.y0 ? (w.baseline.y0 + w.baseline.y1) / 2 : b.y1 - (b.y1 - b.y0) * 0.2;
        words.push({ text: w.text, start: toUser(b.x0, base), end: toUser(b.x1, base), height: (b.y1 - b.y0) / scale });
      }
      found.push({ index, words });
    }
    if (!found.length) return { bytes, pages: 0, words: 0 };

    progress?.({ message: 'Gravando o texto reconhecido…' });
    const out = await PDFDocument.load(bytes, { updateMetadata: false });
    out.registerFontkit(fontkit);
    let font;
    try { font = await out.embedFont(await fs.readFile(config.ocrFont), { subset: true }); } catch { font = await out.embedFont(StandardFonts.Helvetica); }
    let count = 0;
    for (const { index, words } of found) {
      const page = out.getPage(index);
      for (const w of words) {
        const dx = w.end[0] - w.start[0];
        const dy = w.end[1] - w.start[1];
        const width = Math.hypot(dx, dy);
        let text = w.text;
        try { font.encodeText(text); } catch { text = [...text].map((c) => { try { font.encodeText(c); return c; } catch { return '?'; } }).join(''); }
        const unit = font.widthOfTextAtSize(text, 1);
        if (!unit || !width) continue;
        const size = Math.max(2, Math.min(width / unit, w.height * 1.6));
        page.drawText(text, {
          x: w.start[0],
          y: w.start[1],
          size,
          font,
          opacity: 0,
          rotate: degrees((Math.atan2(dy, dx) * 180) / Math.PI),
        });
        count++;
      }
    }
    return { bytes: await out.save({ useObjectStreams: true }), pages: found.length, words: count };
  },

  // PDF -> Word (.docx): parágrafos com fonte, tamanho, negrito, itálico, cor e imagens
  async toDocx({ bytes, title }, progress) {
    const doc = open(bytes);
    const sections = [];
    const total = doc.countPages();
    for (let i = 0; i < total; i++) {
      progress?.({ message: 'Convertendo página {n} de {total}…', vars: { n: i + 1, total } });
      const page = doc.loadPage(i);
      const [x0, y0, x1, y1] = page.getBounds();
      const data = JSON.parse(page.toStructuredText('preserve-images').asJSON());
      const children = [];
      let lastBottom = y0;
      for (const block of data.blocks || []) {
        const gap = Math.max(0, block.bbox.y - lastBottom);
        lastBottom = block.bbox.y + block.bbox.h;
        if (block.type === 'image') {
          const png = renderRegion(page, block.bbox, 150);
          if (!png) continue;
          children.push(new docx.Paragraph({
            spacing: { before: Math.round(Math.min(gap, 40) * 20) },
            indent: { left: Math.round(Math.max(0, block.bbox.x - x0 - 36) * 20) },
            children: [new docx.ImageRun({ type: 'png', data: png, transformation: { width: Math.round(block.bbox.w * 96 / 72), height: Math.round(block.bbox.h * 96 / 72) } })],
          }));
          continue;
        }
        const runs = [];
        (block.lines || []).forEach((line, li) => {
          const font = line.font || {};
          let text = line.text || '';
          if (li < block.lines.length - 1) {
            if (/-$/.test(text)) text = text.slice(0, -1); else text += ' ';
          }
          runs.push(new docx.TextRun({
            text,
            font: wordFont(font.family, font.name),
            size: Math.max(2, Math.round((font.size || 11) * 2)),
            bold: font.weight === 'bold' || /bold|black|heavy/i.test(font.name || ''),
            italics: font.style === 'italic' || /italic|oblique/i.test(font.name || ''),
            color: line.color ? line.color.replace('#', '') : undefined,
          }));
        });
        if (!runs.length) continue;
        children.push(new docx.Paragraph({
          children: runs,
          spacing: { before: Math.round(Math.min(gap, 30) * 20), after: 0 },
          indent: { left: Math.round(Math.max(0, block.bbox.x - x0 - 36) * 20) },
        }));
      }
      if (!children.length) children.push(new docx.Paragraph(''));
      sections.push({
        properties: {
          page: {
            size: { width: Math.round((x1 - x0) * 20), height: Math.round((y1 - y0) * 20) },
            margin: { top: 720, bottom: 720, left: 720, right: 720 },
          },
        },
        children,
      });
    }
    const out = new docx.Document({ title: title || 'Documento', creator: 'Editor PDF', sections });
    return { bytes: new Uint8Array(await docx.Packer.toBuffer(out)) };
  },
};
let tesseract = null;
async function getTesseract() {
  if (!tesseract) {
    tesseract = createWorker(['por', 'eng'], 1, {
      langPath: config.tessdata,
      cachePath: config.tessCache || undefined,
      gzip: true,
    });
  }
  return tesseract;
}

// Mantém cada imagem gerada abaixo de ~60 megapixels (páginas gigantes não estouram a memória)
const MAX_PIXELS = 60e6;
function safeScale(page, wanted) {
  const [x0, y0, x1, y1] = page.getBounds();
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  return Math.min(wanted, Math.sqrt(MAX_PIXELS / area));
}

function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

function wordFont(family, name) {
  const n = `${name || ''} ${family || ''}`.toLowerCase();
  if (/calibri/.test(n)) return 'Calibri';
  if (/cambria/.test(n)) return 'Cambria';
  if (/georgia/.test(n)) return 'Georgia';
  if (/verdana/.test(n)) return 'Verdana';
  if (/courier|mono/.test(n)) return 'Courier New';
  if (/times|serif/.test(n) && !/sans/.test(n)) return 'Times New Roman';
  return 'Arial';
}

// Renderiza um pedaço da página (usado para levar imagens para o Word)
function renderRegion(page, bbox, dpi) {
  try {
    const s = dpi / 72;
    const w = Math.max(1, Math.round(bbox.w * s));
    const h = Math.max(1, Math.round(bbox.h * s));
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
    pix.clear(255);
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
    page.run(dev, [s, 0, 0, s, -bbox.x * s, -bbox.y * s]);
    dev.close();
    return new Uint8Array(pix.asPNG());
  } catch {
    return null;
  }
}
