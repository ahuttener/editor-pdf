// "Editar texto": encontra as frases da página (pdf.js), mostra áreas clicáveis e, ao clicar,
// cobre a frase original com a cor do fundo e coloca uma caixa de texto editável no lugar.
import { pdfjs, fabric, TEXT_BASELINE_RATIO, newUid } from './libs.js';
import { t } from './i18n.js';

function familyFromName(name, generic) {
  const n = (name || '').toLowerCase();
  if (/calibri/.test(n)) return 'Calibri';
  if (/verdana/.test(n)) return 'Verdana';
  if (/georgia/.test(n)) return 'Georgia';
  if (/courier|mono|consol/.test(n)) return 'Courier New';
  if (/times|serif|roman|garamond|cambria|minion/.test(n) && !/sans/.test(n)) return 'Times New Roman';
  if (/arial|helvetica|sans/.test(n)) return 'Arial';
  if (generic === 'monospace') return 'Courier New';
  if (generic === 'serif') return 'Times New Roman';
  return 'Arial';
}

// Agrupa os pedaços de texto do pdf.js em frases (mesma linha, próximos e do mesmo tamanho)
// includeRotated: devolve também o texto girado na tela (para a busca), um pedaço por item
export async function loadTextRuns(entry, { includeRotated = false } = {}) {
  const vp = entry.viewport();
  const content = await entry.proxy.getTextContent();
  const items = [];
  const rotated = [];
  for (const it of content.items) {
    if (!it.str || !it.str.trim()) continue;
    const tx = pdfjs.Util.transform(vp.transform, it.transform);
    if (Math.abs(Math.atan2(tx[1], tx[0])) > 0.02) { // texto girado em relação à tela
      if (includeRotated) rotated.push(rotatedBox(vp, it));
      continue;
    }
    const height = Math.hypot(tx[2], tx[3]);
    if (height < 2) continue;
    const style = content.styles[it.fontName] || {};
    const ascent = style.ascent || (style.descent ? 1 + style.descent : 0.8);
    items.push({
      str: it.str,
      left: tx[4],
      baseline: tx[5],
      height,
      ascent,
      width: it.width * vp.scale,
      fontName: it.fontName,
      generic: style.fontFamily,
    });
  }

  items.sort((a, b) => a.baseline - b.baseline);
  const lines = [];
  for (const it of items) {
    const line = lines.find((l) => Math.abs(l.baseline - it.baseline) < Math.min(l.height, it.height) * 0.35);
    if (line) line.items.push(it);
    else lines.push({ baseline: it.baseline, height: it.height, items: [it] });
  }

  const runs = [];
  for (const line of lines) {
    line.items.sort((a, b) => a.left - b.left);
    let run = null;
    for (const it of line.items) {
      const right = run ? run.left + run.width : 0;
      const gap = run ? it.left - right : 0;
      const sameSize = run && it.height / run.height > 0.8 && it.height / run.height < 1.25;
      if (run && sameSize && gap < run.height * 0.9 && gap > -run.height * 0.5) {
        const needsSpace = gap > run.height * 0.15 && !run.str.endsWith(' ') && !it.str.startsWith(' ');
        run.str += (needsSpace ? ' ' : '') + it.str;
        run.width = Math.max(run.width, it.left + it.width - run.left);
        run.height = Math.max(run.height, it.height);
      } else {
        run = { ...it };
        runs.push(run);
      }
    }
  }

  const flat = runs.map((r, i) => {
    const lead = r.str.length - r.str.trimStart().length;
    const str = r.str.trim();
    const left = r.left + lead * r.height * 0.25;
    return {
      key: `${entry.docKey}:${entry.index}:${entry.rotation()}:${i}`,
      str,
      left,
      width: r.width - (left - r.left),
      top: r.baseline - r.height * r.ascent,
      bottom: r.baseline + r.height * 0.24,
      baseline: r.baseline,
      fontSize: r.height,
      fontName: r.fontName,
      generic: r.generic,
    };
  });
  return flat.concat(rotated.map((r, i) => ({ ...r, key: `${entry.docKey}:${entry.index}:${entry.rotation()}:r${i}` })));
}

// Caixa (alinhada à tela) de um pedaço de texto girado
function rotatedBox(vp, it) {
  const [a, b, c, d, e, f] = it.transform;
  const len = Math.hypot(a, b) || 1;
  const up = Math.hypot(c, d) || 1;
  const dir = [a / len, b / len];
  const nrm = [c / up, d / up];
  const h = up;
  const corners = [[0, -0.2 * h], [it.width, -0.2 * h], [it.width, 0.9 * h], [0, 0.9 * h]].map(([x, y]) =>
    vp.convertToViewportPoint(e + dir[0] * x + nrm[0] * y, f + dir[1] * x + nrm[1] * y));
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { str: it.str.trim(), left, top, width: Math.max(...xs) - left, bottom: Math.max(...ys), vertical: true };
}

function fontDetails(entry, run) {
  let bold = false;
  let italic = false;
  let name = '';
  try {
    if (entry.proxy.commonObjs.has(run.fontName)) {
      const f = entry.proxy.commonObjs.get(run.fontName);
      name = `${f.name || ''} ${f.fallbackName || ''} ${f.loadedName || ''}`;
      bold = !!f.bold || /bold|black|heavy|semibold|demi/i.test(name);
      italic = !!f.italic || /italic|oblique/i.test(name);
      if (f.isMonospace) name += ' mono';
      else if (f.isSerifFont && !/sans/i.test(name)) name += ' serif';
    }
  } catch { /* fonte ainda não carregada; usa o genérico */ }
  return { family: familyFromName(name, run.generic), bold, italic };
}

const toHex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

// Lê a cor do fundo (borda da área) e a cor do texto (pixel mais diferente do fundo)
function sampleColors(entry, run) {
  const canvas = entry.pdfCanvas;
  const fallback = { background: '#ffffff', text: '#000000' };
  if (!canvas.width) return fallback;
  const k = canvas.width / entry.viewport().width;
  const x = Math.max(0, Math.floor((run.left - 2) * k));
  const y = Math.max(0, Math.floor((run.top - 2) * k));
  const w = Math.min(canvas.width - x, Math.ceil((run.width + 4) * k));
  const h = Math.min(canvas.height - y, Math.ceil((run.bottom - run.top + 4) * k));
  if (w < 2 || h < 2) return fallback;
  let data;
  try { data = canvas.getContext('2d').getImageData(x, y, w, h).data; } catch { return fallback; }
  const px = (i) => [data[i], data[i + 1], data[i + 2]];
  const counts = new Map();
  const border = [];
  for (let i = 0; i < w; i++) border.push(i, (h - 1) * w + i);
  for (let j = 0; j < h; j++) border.push(j * w, j * w + w - 1);
  for (const idx of border) {
    const c = px(idx * 4).map((v) => v & 0xf0);
    const key = c.join(',');
    counts.set(key, { n: (counts.get(key)?.n || 0) + 1, c: px(idx * 4) });
  }
  const bg = [...counts.values()].sort((a, b) => b.n - a.n)[0]?.c || [255, 255, 255];
  let best = null;
  let bestDist = 0;
  for (let i = 0; i < data.length; i += 4) {
    const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
    if (d > bestDist) { bestDist = d; best = px(i); }
  }
  return { background: toHex(bg), text: bestDist > 90 && best ? toHex(best) : '#000000' };
}

export function createTextEdit(entry, run) {
  const { family, bold, italic } = fontDetails(entry, run);
  const colors = sampleColors(entry, run);
  const pad = Math.max(1, run.fontSize * 0.08);
  const uid = newUid();
  const cover = new fabric.Rect({
    left: run.left - pad,
    top: run.top - pad,
    width: run.width + pad * 2,
    height: run.bottom - run.top + pad * 2,
    fill: colors.background,
    strokeWidth: 0,
    selectable: false,
    evented: false,
    kind: 'cover',
    uid,
    runKey: run.key,
  });
  const text = new fabric.IText(run.str, {
    left: run.left,
    top: run.baseline - run.fontSize * TEXT_BASELINE_RATIO,
    fontSize: run.fontSize,
    fontFamily: family,
    fontWeight: bold ? 'bold' : 'normal',
    fontStyle: italic ? 'italic' : 'normal',
    fill: colors.text,
    kind: 'edited',
    uid: newUid(),
    link: uid,
    runKey: run.key,
  });
  return { cover, text };
}

// Agrupa as frases (linhas) em parágrafos: mesma fonte/tamanho, alinhadas à esquerda
// (o recuo da primeira linha é aceito) e com espaçamento de linha regular
export function groupParagraphs(entry, runs) {
  const lines = runs.filter((r) => !r.vertical).sort((a, b) => a.baseline - b.baseline || a.left - b.left);
  const paras = [];
  for (const line of lines) {
    const p = paras[paras.length - 1];
    const last = p?.lines[p.lines.length - 1];
    const fit = p
      && Math.abs(line.fontSize - p.fontSize) <= p.fontSize * 0.12
      && line.generic === p.generic
      && line.baseline - last.baseline > p.fontSize * 0.8
      && line.baseline - last.baseline <= p.fontSize * 1.9
      && (p.lines.length < 2 || Math.abs((line.baseline - last.baseline) - p.gap) <= p.fontSize * 0.25)
      && Math.abs(line.left - p.left) <= p.fontSize * 2.5
      && line.left < p.right; // não junta colunas lado a lado
    if (fit) {
      if (p.lines.length === 1) p.gap = line.baseline - last.baseline;
      p.lines.push(line);
      p.left = Math.min(p.left, line.left);
      p.right = Math.max(p.right, line.left + line.width);
    } else {
      paras.push({ lines: [line], fontSize: line.fontSize, generic: line.generic, left: line.left, right: line.left + line.width, gap: line.fontSize * 1.2 });
    }
  }
  return paras.map((p, i) => {
    const first = p.lines[0];
    const last = p.lines[p.lines.length - 1];
    let text = '';
    p.lines.forEach((l, k) => {
      if (k === 0) text = l.str;
      else if (/[A-Za-zÀ-ú]-$/.test(text)) text = text.slice(0, -1) + l.str; // palavra hifenizada no fim da linha
      else text += ' ' + l.str;
    });
    const para = {
      key: `${entry.docKey}:${entry.index}:${entry.rotation()}:p${i}`,
      str: text,
      left: p.left,
      width: p.right - p.left,
      top: first.top,
      bottom: last.bottom,
      baseline: first.baseline,
      fontSize: first.fontSize,
      fontName: first.fontName,
      generic: first.generic,
      gap: p.gap,
      indent: first.left - p.left,
      lineKeys: p.lines.map((l) => l.key),
    };
    for (const l of p.lines) l.paraKey = para.key;
    return para;
  });
}

// Editar parágrafo: o texto novo se reorganiza (refluxo) dentro da largura original
export function createParagraphEdit(entry, para) {
  const { family, bold, italic } = fontDetails(entry, para);
  const colors = sampleColors(entry, para);
  const pad = Math.max(1, para.fontSize * 0.08);
  const uid = newUid();
  const cover = new fabric.Rect({
    left: para.left - pad,
    top: para.top - pad,
    width: para.width + pad * 2,
    height: para.bottom - para.top + pad * 2,
    fill: colors.background,
    strokeWidth: 0,
    selectable: false,
    evented: false,
    kind: 'cover',
    uid,
    runKey: para.key,
  });
  const lineHeight = Math.max(0.8, para.gap / (para.fontSize * 1.13));
  const text = new fabric.Textbox(para.str, {
    left: para.left,
    top: para.baseline - para.fontSize * TEXT_BASELINE_RATIO,
    width: para.width + para.fontSize * 0.5,
    fontSize: para.fontSize,
    lineHeight,
    fontFamily: family,
    fontWeight: bold ? 'bold' : 'normal',
    fontStyle: italic ? 'italic' : 'normal',
    fill: colors.text,
    splitByGrapheme: false,
    kind: 'edited',
    uid: newUid(),
    link: uid,
    runKey: para.key,
  });
  return { cover, text };
}

// Áreas clicáveis por cima das frases ou parágrafos ("Editar texto" / "Editar parágrafo")
export function renderTextHits(entry, zoom, onPick, paragraphs = false) {
  const layer = entry.hitLayer;
  layer.replaceChildren();
  if (!entry.runs) return;
  const used = new Set(entry.plainObjects().map((o) => o.runKey).filter(Boolean));
  const items = paragraphs ? (entry.paras || []) : entry.runs.filter((r) => !r.vertical);
  for (const run of items) {
    if (used.has(run.key) || (run.paraKey && used.has(run.paraKey)) || run.lineKeys?.some((k) => used.has(k))) continue;
    const el = document.createElement('div');
    el.className = 'text-hit';
    Object.assign(el.style, {
      left: `${(run.left - 1) * zoom}px`,
      top: `${(run.top - 1) * zoom}px`,
      width: `${(run.width + 2) * zoom}px`,
      height: `${(run.bottom - run.top + 2) * zoom}px`,
    });
    el.title = t(paragraphs ? 'Clique para editar este parágrafo' : 'Clique para editar este texto');
    el.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); onPick(entry, run); });
    layer.append(el);
  }
}
