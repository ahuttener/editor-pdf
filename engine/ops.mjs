// Operações do motor PDF (MuPDF + Tesseract): senha/criptografia, redação (apagar de verdade),
// compressão, exportação de páginas como imagem, texto com estilo e OCR.
import * as mupdf from 'mupdf';
import { PDFDocument, StandardFonts, PDFName, PDFHexString, PDFArray, PDFDict, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { createWorker } from 'tesseract.js';
import * as docx from 'docx';

// readFile, tessWorker e tessCore permitem rodar o motor fora do Node (Web Worker do app mobile)
const config = { tessdata: null, tessCache: null, ocrFont: null, srgb: null, readFile: null, tessWorker: null, tessCore: null, tessGzip: true, maxPixels: 60e6 };
export function configure(values) { Object.assign(config, values); }
const readFile = async (p) => (config.readFile ? config.readFile(p) : (await import('node:fs/promises')).readFile(p));

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
      for (const mode of ['text', 'art', 'all']) {
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
        } else if (mode === 'art') {
          // palavra desenhada (letras em contorno): some o traço que fica inteiro dentro da área; fundo e imagens ficam
          page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, mupdf.PDFPage.REDACT_TEXT_REMOVE);
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
      pix.destroy(); // a memória do WASM não encolhe: liberar cada imagem assim que usada
      page.destroy();
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
        const png = pix.asPNG();
        const px = { x: pix.getX(), y: pix.getY() };
        pix.destroy();
        const { data } = await tess.recognize(typeof Buffer === 'function' ? Buffer.from(png) : png, {}, { blocks: true });
        if (!best || data.confidence > best.data.confidence) best = { data, matrix, ...px };
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
      page.destroy();
    }
    if (!found.length) return { bytes, pages: 0, words: 0 };

    progress?.({ message: 'Gravando o texto reconhecido…' });
    const out = await PDFDocument.load(bytes, { updateMetadata: false });
    out.registerFontkit(fontkit);
    let font;
    try { font = await out.embedFont(await readFile(config.ocrFont), { subset: true }); } catch { font = await out.embedFont(StandardFonts.Helvetica); }
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

  // OCR de um recorte (palavra desenhada que o usuário quer editar): linhas com caixa, linha de base e altura
  async ocrImage({ png }) {
    const tess = await getTesseract();
    const { data } = await tess.recognize(typeof Buffer === 'function' ? Buffer.from(png) : png, {}, { blocks: true });
    const lines = [];
    for (const block of data.blocks || []) for (const para of block.paragraphs) for (const line of para.lines) {
      const words = line.words.filter((w) => w.text.trim() && w.confidence >= 30);
      if (!words.length) continue;
      lines.push({
        text: words.map((w) => w.text).join(' '),
        bbox: line.bbox,
        baseline: line.baseline,
        rowHeight: line.rowAttributes?.row_height || 0,
        confidence: line.confidence,
        words: words.map((w) => ({ text: w.text, bbox: w.bbox })),
      });
    }
    return { lines };
  },

  // Fontes sem o arquivo da fonte dentro do PDF (impedem um PDF/A válido)
  fontReport({ bytes }) {
    return { missing: missingFonts(open(bytes)) };
  },

  // PDF/A-2b: metadados XMP, perfil de cor sRGB, identificador, sem anotações sem aparência.
  // mode 'keep' exige fontes incorporadas; mode 'raster' converte as páginas em imagem + OCR
  async pdfa({ bytes, title, lang, mode }, progress) {
    if (!config.srgb) throw new Error('Perfil de cor sRGB não encontrado neste computador.');
    let src = bytes;
    if (mode === 'raster') {
      const doc = open(bytes);
      const out = await PDFDocument.create();
      const total = doc.countPages();
      for (let i = 0; i < total; i++) {
        progress?.({ message: 'Convertendo página {n} de {total}…', vars: { n: i + 1, total } });
        const page = doc.loadPage(i);
        const [x0, y0, x1, y1] = page.getBounds();
        const scale = safeScale(page, 200 / 72);
        const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
        const jpg = pix.asJPEG(85, false);
        pix.destroy();
        page.destroy();
        const img = await out.embedJpg(jpg);
        out.addPage([x1 - x0, y1 - y0]).drawImage(img, { x: 0, y: 0, width: x1 - x0, height: y1 - y0 });
      }
      src = (await ops.ocr({ bytes: new Uint8Array(await out.save()), force: true }, progress)).bytes;
    } else {
      const missing = missingFonts(open(src));
      if (missing.length) return { ok: false, fonts: missing };
    }
    progress?.({ message: 'Gerando PDF/A…' });
    const out = await PDFDocument.load(src, { updateMetadata: false });
    // anotações sem aparência (ex.: notas) não são permitidas no PDF/A
    for (const page of out.getPages()) {
      const annots = page.node.Annots();
      if (!annots) continue;
      const keep = annots.asArray().filter((ref) => {
        const dict = out.context.lookup(ref, PDFDict);
        const sub = dict.get(PDFName.of('Subtype'))?.toString();
        return sub === '/Link' || sub === '/Popup' || dict.has(PDFName.of('AP'));
      });
      page.node.set(PDFName.of('Annots'), out.context.obj(keep));
    }
    const now = new Date();
    const created = out.getCreationDate() || now;
    const docTitle = title || out.getTitle() || 'Documento';
    out.setTitle(docTitle, { showInWindowTitleBar: true });
    out.setProducer('Editor PDF (CyberSecInfo)');
    out.setCreator('Editor PDF');
    out.setCreationDate(created);
    out.setModificationDate(now);
    if (lang) out.setLanguage(lang);
    const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const xmp = `<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
   <pdfaid:part>2</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(docTitle)}</rdf:li></rdf:Alt></dc:title>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <xmp:CreateDate>${iso(created)}</xmp:CreateDate>
   <xmp:ModifyDate>${iso(now)}</xmp:ModifyDate>
   <xmp:MetadataDate>${iso(now)}</xmp:MetadataDate>
   <xmp:CreatorTool>Editor PDF</xmp:CreatorTool>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <pdf:Producer>Editor PDF (CyberSecInfo)</pdf:Producer>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
    const meta = out.context.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' });
    out.catalog.set(PDFName.of('Metadata'), out.context.register(meta));
    const icc = await readFile(config.srgb);
    const iccRef = out.context.register(out.context.flateStream(icc, { N: 3 }));
    const intent = out.context.obj({
      Type: 'OutputIntent', S: 'GTS_PDFA1', OutputConditionIdentifier: PDFHexString.fromText('sRGB IEC61966-2.1'),
      Info: PDFHexString.fromText('sRGB IEC61966-2.1'), DestOutputProfile: iccRef,
    });
    out.catalog.set(PDFName.of('OutputIntents'), out.context.obj([intent]));
    const id = PDFHexString.of([...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''));
    out.context.trailerInfo.ID = out.context.obj([id, id]);
    return { ok: true, bytes: new Uint8Array(await out.save({ useObjectStreams: false })) };
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
      // "table-hunt" (com "segment") faz o MuPDF reconhecer tabelas: viram tabelas de verdade no Word
      let data;
      try { data = JSON.parse(page.toStructuredText('preserve-images,preserve-whitespace,segment,table-hunt').asJSON()); }
      catch { data = JSON.parse(page.toStructuredText('preserve-images,preserve-whitespace').asJSON()); }
      const ctx = { page, x0, lastBottom: y0, consumed: new Set(), extra: new Map(), core: new Map() };
      prepareTables(data.blocks || [], ctx);
      const children = docxBlocks(data.blocks || [], ctx);
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
    return { bytes: new Uint8Array(await docx.Packer.toArrayBuffer(out)) };
  },
};
let tesseract = null;
async function getTesseract() {
  if (!tesseract) {
    tesseract = createWorker(['por', 'eng'], 1, {
      langPath: config.tessdata,
      cachePath: config.tessCache || undefined,
      gzip: config.tessGzip,
      ...(config.tessWorker && { workerPath: config.tessWorker, corePath: config.tessCore, workerBlobURL: false }),
    });
  }
  return tesseract;
}

// Mantém cada imagem gerada abaixo de config.maxPixels (~60 megapixels no computador) (páginas gigantes não estouram a memória)
function safeScale(page, wanted) {
  const [x0, y0, x1, y1] = page.getBounds();
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  return Math.min(wanted, Math.sqrt(config.maxPixels / area));
}

// Lista as fontes usadas que não têm o arquivo da fonte embutido
function missingFonts(doc) {
  const missing = new Set();
  const count = doc.countObjects();
  for (let n = 1; n < count; n++) {
    let o;
    try { o = doc.newIndirect(n, 0); } catch { continue; }
    if (!o.isDictionary() || o.get('Type').toString() !== '/Font') continue;
    const sub = o.get('Subtype').toString();
    if (sub === '/Type3' || sub === '/Type0') continue; // Type0: a fonte real está nas DescendantFonts
    const desc = o.get('FontDescriptor');
    const embedded = desc && !desc.isNull() && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => !desc.get(k).isNull());
    if (!embedded) missing.add(o.get('BaseFont').toString().replace(/^\//, ''));
  }
  return [...missing];
}

function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

// Todos os blocos de texto da página, em ordem (inclusive dentro de estruturas)
function flatText(blocks, out = [], inTable = null) {
  for (const b of blocks) {
    if (b.type === 'structure') flatText(b.contents || [], out, b.std === 'Table' ? b : inTable);
    else if (b.type === 'text' && b.bbox) out.push({ block: b, table: inTable });
  }
  return out;
}

const cellsOf = (row) => (row.contents || []).filter((c) => c.std === 'TD' || c.std === 'TH');
const blocksOf = (row) => cellsOf(row).flatMap((c) => flatText(c.contents || []).map((t) => t.block));
const textOf = (blocks) => blocks.map((b) => (b.lines || []).map((l) => l.text).join(' ')).join(' ').trim();

// Separa as linhas que são mesmo tabela das linhas da borda que o MuPDF juntou por engano
// (título acima, total abaixo, frase partida em duas "células")
function tableCore(table) {
  const rows = (table.contents || []).filter((c) => c.type === 'structure' && c.std === 'TR');
  const notTable = (r) => {
    const filled = cellsOf(r).map((c) => flatText(c.contents || []).map((t) => t.block)).filter((bs) => textOf(bs));
    if (filled.length < 2) return true;
    if (filled.length === 2) {
      const [a, b] = filled.map((bs) => bs[0]);
      const gap = b.bbox.x - (a.bbox.x + a.bbox.w);
      const ta = textOf(filled[0]);
      const tb = textOf(filled[1]);
      if (gap < 4 && /[\p{L}]$/u.test(ta) && /^[\p{Ll}]/u.test(tb)) return true;
    }
    return false;
  };
  const before = [];
  const after = [];
  while (rows.length && notTable(rows[0])) before.push(rows.shift());
  while (rows.length && notTable(rows[rows.length - 1])) after.unshift(rows.pop());
  return { rows, before, after };
}

// O MuPDF às vezes reconhece só parte das colunas: texto na altura das linhas da tabela e à direita
// das colunas reconhecidas vira coluna extra (em vez de cair solto depois da tabela)
function prepareTables(blocks, ctx) {
  const all = flatText(blocks);
  const tables = [];
  const findTables = (list) => { for (const b of list) if (b.type === 'structure') { if (b.std === 'Table') tables.push(b); else findTables(b.contents || []); } };
  findTables(blocks);
  for (const table of tables) {
    const core = tableCore(table);
    ctx.core.set(table, core);
    if (!core.rows.length) continue;
    const rowBlocks = core.rows.map(blocksOf);
    const own = rowBlocks.flat();
    if (!own.length) continue;
    const centers = rowBlocks.map((bs) => (bs.length ? Math.min(...bs.map((b) => b.bbox.y + b.bbox.h / 2)) : null));
    const top = Math.min(...own.map((b) => b.bbox.y)) - 2;
    const bottom = Math.max(...own.map((b) => b.bbox.y + b.bbox.h)) + 2;
    const right = Math.max(...own.map((b) => b.bbox.x + b.bbox.w));
    const extras = all.filter((t) => t.table !== table && !ctx.consumed.has(t.block)).map((t) => t.block).filter((b) => {
      const cy = b.bbox.y + b.bbox.h / 2;
      return cy >= top && cy <= bottom && b.bbox.x >= right - 2;
    });
    if (!extras.length) continue;
    const colsX = [];
    for (const b of [...extras].sort((a, c) => a.bbox.x - c.bbox.x)) {
      if (!colsX.length || b.bbox.x - colsX[colsX.length - 1] > 24) colsX.push(b.bbox.x);
    }
    const cells = new Map();
    for (const b of extras) {
      const cy = b.bbox.y + b.bbox.h / 2;
      let row = 0;
      let best = Infinity;
      centers.forEach((c, i) => { if (c !== null && Math.abs(c - cy) < best) { best = Math.abs(c - cy); row = i; } });
      let col = 0;
      for (let k = 0; k < colsX.length; k++) if (b.bbox.x >= colsX[k] - 2) col = k;
      const key = `${row}:${col}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(b);
      ctx.consumed.add(b);
    }
    ctx.extra.set(table, { cols: colsX.length, cells });
  }
}

// Converte os blocos do MuPDF (texto, imagem, estrutura/tabela) em elementos do Word
function docxBlocks(blocks, ctx, inCell = false) {
  const out = [];
  for (const block of blocks) {
    if (block.type === 'grid' || ctx.consumed.has(block)) continue;
    if (block.type === 'structure') {
      if (block.std === 'Table') out.push(...docxTable(block, ctx));
      else out.push(...docxBlocks(block.contents || [], ctx, inCell));
      continue;
    }
    if (!block.bbox) continue;
    const gap = inCell ? 0 : Math.max(0, block.bbox.y - ctx.lastBottom);
    if (!inCell) ctx.lastBottom = block.bbox.y + block.bbox.h;
    const indent = inCell ? 0 : Math.round(Math.max(0, block.bbox.x - ctx.x0 - 36) * 20);
    if (block.type === 'image') {
      const png = renderRegion(ctx.page, block.bbox, 150);
      if (!png) continue;
      out.push(new docx.Paragraph({
        spacing: { before: Math.round(Math.min(gap, 40) * 20) },
        indent: { left: indent },
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
    out.push(new docx.Paragraph({ children: runs, spacing: { before: Math.round(Math.min(gap, 30) * 20), after: 0 }, indent: { left: indent } }));
  }
  return out;
}

// Devolve [parágrafos antes, tabela, parágrafos depois]
function docxTable(block, ctx) {
  const { rows, before, after } = ctx.core.get(block) || tableCore(block);
  // linha que não é tabela vira um parágrafo só (junta "Orçamento d" + "e móveis")
  const asParagraph = (r) => {
    const bs = blocksOf(r).sort((a, b) => a.bbox.x - b.bbox.x);
    if (!bs.length) return [];
    let text = '';
    bs.forEach((b, i) => {
      const t = textOf([b]);
      if (i && b.bbox.x - (bs[i - 1].bbox.x + bs[i - 1].bbox.w) > 3) text += ' ';
      text += t;
    });
    const first = bs[0];
    const merged = { type: 'text', bbox: { x: first.bbox.x, y: Math.min(...bs.map((b) => b.bbox.y)), w: 1, h: Math.max(...bs.map((b) => b.bbox.h)) }, lines: [{ ...first.lines[0], text }] };
    return docxBlocks([merged], ctx);
  };
  if (!rows.length) return [...before, ...after].flatMap(asParagraph);
  const head = before.flatMap(asParagraph);
  const cols = Math.max(...rows.map((r) => cellsOf(r).length));
  const extra = ctx.extra.get(block);
  const tableRows = rows.map((r, ri) => {
    const cells = cellsOf(r);
    while (cells.length < cols) cells.push({ contents: [] });
    const children = cells.map((c) => {
      const paras = docxBlocks(c.contents || [], ctx, true);
      return new docx.TableCell({ children: paras.length ? paras : [new docx.Paragraph('')] });
    });
    for (let k = 0; k < (extra?.cols || 0); k++) {
      const paras = docxBlocks(extra.cells.get(`${ri}:${k}`) || [], { ...ctx, consumed: new Set() }, true);
      children.push(new docx.TableCell({ children: paras.length ? paras : [new docx.Paragraph('')] }));
    }
    return new docx.TableRow({ children });
  });
  const bottoms = rows.flatMap(blocksOf).map((x) => x.bbox.y + x.bbox.h);
  if (bottoms.length) ctx.lastBottom = Math.max(ctx.lastBottom, ...bottoms);
  const table = new docx.Table({ rows: tableRows, width: { size: 100, type: docx.WidthType.PERCENTAGE } });
  return [...head, table, ...after.flatMap(asParagraph)];
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
