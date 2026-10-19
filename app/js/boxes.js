// Detecta onde se escreve num formulário "chapado" (sem campos de verdade): fileiras de
// caixinhas de uma letra, caixas de marcar, caixas maiores e linhas de sublinhado.
// Lê os desenhos da página (lista de operadores do pdf.js) e o texto, sem depender de tela,
// por isso serve ao desktop e ao app. Coordenadas de saída = viewport passado (escala 1).

const TOL = 2.5;       // folga para considerar que duas linhas se encontram
const MIN_CELL = 5;
const MAX_CELL_H = 160;

const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

// Segmentos horizontais e verticais desenhados na página (traços e retângulos finos preenchidos)
function collectSegments(opList, OPS, vpTransform) {
  const { fnArray, argsArray } = opList;
  const H = [];
  const V = [];
  const STROKES = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const FILLS = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  let gs = { ctm: [1, 0, 0, 1, 0, 0], fill: '#000000', stroke: '#000000' };
  const stack = [];

  const addSeg = (a, b, painted) => {
    const dx = Math.abs(a[0] - b[0]);
    const dy = Math.abs(a[1] - b[1]);
    if (dy < 0.8 && dx > 2) H.push({ y: (a[1] + b[1]) / 2, x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), painted });
    else if (dx < 0.8 && dy > 2) V.push({ x: (a[0] + b[0]) / 2, y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]), painted });
  };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save) stack.push({ ...gs });
    else if (fn === OPS.restore) gs = stack.pop() || gs;
    else if (fn === OPS.transform) gs.ctm = mul(gs.ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push({ ...gs }); if (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0])) gs.ctm = mul(gs.ctm, Array.from(args[0])); }
    else if (fn === OPS.paintFormXObjectEnd) gs = stack.pop() || gs;
    else if (fn === OPS.setFillRGBColor) gs.fill = args[0];
    else if (fn === OPS.setStrokeRGBColor) gs.stroke = args[0];
    else if (fn === OPS.constructPath) {
      const paint = args[0];
      const data = args[1]?.[0];
      if (!data || typeof data.length !== 'number') continue;
      const stroked = STROKES.has(paint) && luminance(gs.stroke) < 0.85;
      const filled = FILLS.has(paint) && luminance(gs.fill) < 0.85;
      if (!stroked && !filled) continue;
      const m = mul(vpTransform, gs.ctm);
      // percorre os subcaminhos: 0 moveTo, 1 lineTo, 2 curveTo, 3 quadraticCurveTo, 4 closePath
      const subpaths = [];
      let cur = null;
      for (let j = 0; j < data.length;) {
        const op = data[j];
        if (op === 0) { cur = { pts: [apply(m, data[j + 1], data[j + 2])], curved: false, closed: false }; subpaths.push(cur); j += 3; }
        else if (op === 1) { cur?.pts.push(apply(m, data[j + 1], data[j + 2])); j += 3; }
        else if (op === 2) { if (cur) { cur.curved = true; cur.pts.push(apply(m, data[j + 5], data[j + 6])); } j += 7; }
        else if (op === 3) { if (cur) { cur.curved = true; cur.pts.push(apply(m, data[j + 3], data[j + 4])); } j += 5; }
        else if (op === 4) { if (cur) cur.closed = true; j += 1; }
        else break; // formato desconhecido: não arrisca
      }
      for (const sp of subpaths) {
        const pts = sp.pts;
        if (stroked) {
          for (let k = 1; k < pts.length; k++) addSeg(pts[k - 1], pts[k], true);
          if (sp.closed && pts.length > 2) addSeg(pts[pts.length - 1], pts[0], true);
        }
        if (filled && !sp.curved && pts.length >= 4 && pts.length <= 5) {
          // retângulo preenchido bem fino = uma linha
          const xs = pts.map((p) => p[0]);
          const ys = pts.map((p) => p[1]);
          const w = Math.max(...xs) - Math.min(...xs);
          const h = Math.max(...ys) - Math.min(...ys);
          if (h <= 2.5 && w > 2) addSeg([Math.min(...xs), Math.min(...ys) + h / 2], [Math.max(...xs), Math.min(...ys) + h / 2], true);
          else if (w <= 2.5 && h > 2) addSeg([Math.min(...xs) + w / 2, Math.min(...ys)], [Math.min(...xs) + w / 2, Math.max(...ys)], true);
        }
      }
    }
  }
  return { H: mergeSegs(H, 'y', 'x0', 'x1'), V: mergeSegs(V, 'x', 'y0', 'y1') };
}

// Junta segmentos na mesma linha que se tocam ou se sobrepõem
function mergeSegs(list, pos, a, b) {
  // agrupa por posição (com folga) e, dentro de cada grupo, junta na ordem do comprimento
  list.sort((s, t) => s[pos] - t[pos]);
  const groups = [];
  for (const s of list) {
    const g = groups[groups.length - 1];
    if (g && s[pos] - g[0][pos] <= 0.9) g.push(s);
    else groups.push([s]);
  }
  const out = [];
  for (const g of groups) {
    g.sort((s, t) => s[a] - t[a]);
    let cur = null;
    for (const s of g) {
      if (cur && s[a] <= cur[b] + 1.5) cur[b] = Math.max(cur[b], s[b]);
      else { cur = { ...s }; out.push(cur); }
    }
  }
  return out;
}

// Caixas de texto do pdf.js em coordenadas do viewport (para saber onde já tem algo escrito)
function textBoxes(textContent, vpTransform) {
  const boxes = [];
  const leaders = [];
  for (const it of textContent?.items || []) {
    if (!it.str || !it.str.trim()) continue;
    const tx = mul(vpTransform, it.transform);
    if (Math.abs(tx[1]) > 0.01 * Math.abs(tx[0]) + 0.01) continue; // texto girado: ignora
    const height = Math.hypot(tx[2], tx[3]);
    const scale = Math.hypot(vpTransform[0], vpTransform[1]) || 1;
    const width = it.width * scale;
    const left = tx[4];
    const top = tx[5] - height * 0.85;
    const bottom = tx[5] + height * 0.2;
    // sublinhados ou pontilhados digitados ("Nome: ________" / "Nome: ..........")
    const re = /_{3,}|\.{6,}|…{2,}/g;
    let m;
    while ((m = re.exec(it.str))) {
      const n = it.str.length;
      leaders.push({ left: left + width * (m.index / n), right: left + width * ((m.index + m[0].length) / n), baseline: tx[5], height });
    }
    if (!it.str.replace(re, '').trim()) continue;
    boxes.push({ left, right: left + width, top, bottom });
  }
  return { boxes, leaders };
}

function overlapX(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }

// Células fechadas: duas horizontais (topo e base) e verticais que vão de uma à outra
function findCells(H, V) {
  const cells = [];
  const usedH = new Set();
  const Hs = [...H].sort((a, b) => a.y - b.y);
  for (let i = 0; i < Hs.length; i++) {
    const A = Hs[i];
    for (let j = i + 1; j < Hs.length; j++) {
      const B = Hs[j];
      const dy = B.y - A.y;
      if (dy < MIN_CELL) continue;
      if (dy > MAX_CELL_H) break;
      const x0 = Math.max(A.x0, B.x0) - TOL;
      const x1 = Math.min(A.x1, B.x1) + TOL;
      if (x1 - x0 < MIN_CELL) continue;
      const xs = V.filter((v) => v.x >= x0 && v.x <= x1 && v.y0 <= A.y + TOL && v.y1 >= B.y - TOL).map((v) => v.x).sort((a, b) => a - b);
      const cols = [];
      for (const x of xs) if (!cols.length || x - cols[cols.length - 1] > 2) cols.push(x);
      for (let k = 1; k < cols.length; k++) {
        const cx0 = cols[k - 1];
        const cx1 = cols[k];
        if (cx1 - cx0 < MIN_CELL) continue;
        // as duas horizontais precisam cobrir a célula inteira
        if (overlapX(A.x0, A.x1, cx0, cx1) < (cx1 - cx0) - TOL * 2 || overlapX(B.x0, B.x1, cx0, cx1) < (cx1 - cx0) - TOL * 2) continue;
        // nenhuma horizontal no meio cortando a célula (senão é a soma de duas células)
        const split = Hs.some((h) => h.y > A.y + TOL && h.y < B.y - TOL && overlapX(h.x0, h.x1, cx0, cx1) > (cx1 - cx0) * 0.8);
        if (split) continue;
        cells.push({ left: cx0, right: cx1, top: A.y, bottom: B.y });
        usedH.add(A); usedH.add(B);
      }
    }
  }
  return { cells, usedH };
}

// Quanto da célula está ocupado por texto impresso; devolve a área livre ou null
function freeArea(cell, texts) {
  const w = cell.right - cell.left;
  const inside = texts.filter((t) => overlapX(t.left, t.right, cell.left, cell.right) > 1 && t.bottom > cell.top + 1 && t.top < cell.bottom - 1);
  if (!inside.length) return { ...cell };
  const lowest = Math.max(...inside.map((t) => t.bottom));
  if (cell.bottom - lowest >= 11 && w >= 30) return { ...cell, top: lowest + 1 };
  const rightmost = Math.max(...inside.map((t) => t.right));
  if (cell.right - rightmost >= 40) return { ...cell, left: rightmost + 3 };
  return null;
}

const key = (type, b) => `${type}:${Math.round(b.left)}:${Math.round(b.top)}`;

// opList: page.getOperatorList(); textContent: page.getTextContent();
// OPS: pdfjs.OPS; viewport: page.getViewport({ scale: 1, rotation })
export function detectBoxes({ opList, textContent, OPS, viewport }) {
  const vt = viewport.transform;
  const { H, V } = collectSegments(opList, OPS, vt);
  const { boxes: texts, leaders } = textBoxes(textContent, vt);
  const { cells, usedH } = findCells(H, V);
  const pageW = viewport.width;
  const out = [];

  // células menores dentro de outras maiores não contam duas vezes (a maior sai)
  const big = cells.filter((c) => c.right - c.left < pageW * 0.97);
  const isCharCell = (c) => {
    const w = c.right - c.left;
    const h = c.bottom - c.top;
    return w <= 32 && h <= 40 && w <= h * 1.6;
  };

  // fileiras de caixinhas de uma letra: mesma altura e coladas umas nas outras
  const charCells = big.filter(isCharCell).sort((a, b) => a.top - b.top || a.left - b.left);
  const rows = [];
  for (const c of charCells) {
    const row = rows.find((r) => Math.abs(r.top - c.top) <= 1.5 && Math.abs(r.bottom - c.bottom) <= 1.5 && c.left - r.cells[r.cells.length - 1].right <= TOL && c.left >= r.cells[r.cells.length - 1].left + 1);
    if (row) row.cells.push(c);
    else rows.push({ top: c.top, bottom: c.bottom, cells: [c] });
  }
  for (const row of rows) {
    if (row.cells.length === 1) {
      const c = row.cells[0];
      const w = c.right - c.left;
      const h = c.bottom - c.top;
      if (freeArea(c, texts) && w <= 22 && h <= 22 && Math.abs(w - h) <= Math.max(w, h) * 0.4) {
        out.push({ type: 'check', left: c.left, top: c.top, width: w, height: h });
        continue;
      }
    }
    // caixinhas com algo impresso (ex.: o "2 0" do ano) quebram a fileira
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const left = run[0].left;
      const right = run[run.length - 1].right;
      out.push({ type: 'comb', left, top: row.top, width: right - left, height: row.bottom - row.top, cells: run.map((c) => ({ left: c.left, width: c.right - c.left })), pitch: (right - left) / run.length });
      run = [];
    };
    for (const c of row.cells) {
      const occupied = texts.some((t) => overlapX(t.left, t.right, c.left, c.right) > (c.right - c.left) * 0.25 && t.bottom > c.top + 1 && t.top < c.bottom - 1);
      if (occupied) flush(); else run.push(c);
    }
    flush();
  }

  // caixas maiores (nome, assinatura...), descontando o rótulo impresso dentro delas
  const containsOther = (c) => cells.some((o) => o !== c && o.left >= c.left - 1 && o.right <= c.right + 1 && o.top >= c.top - 1 && o.bottom <= c.bottom + 1);
  for (const c of big) {
    if (isCharCell(c) || containsOther(c)) continue;
    const area = freeArea(c, texts);
    if (!area || area.right - area.left < 20 || area.bottom - area.top < 8) continue;
    out.push({ type: 'text', left: area.left, top: area.top, width: area.right - area.left, height: area.bottom - area.top });
  }

  // linhas soltas para escrever em cima ("Nome: ________")
  for (const h of H) {
    if (usedH.has(h)) continue;
    const len = h.x1 - h.x0;
    if (len < 30 || len > pageW * 0.9) continue;
    if (V.some((v) => v.x >= h.x0 - TOL && v.x <= h.x1 + TOL && v.y0 <= h.y + TOL && v.y1 >= h.y - TOL)) continue;
    // altura livre acima da linha (até o texto ou a linha de cima)
    let room = 18;
    for (const o of H) if (o !== h && o.y < h.y && overlapX(o.x0, o.x1, h.x0, h.x1) > len * 0.3) room = Math.min(room, h.y - o.y - 1);
    if (room < 9) continue;
    const top = h.y - room;
    const covered = texts.filter((t) => t.bottom > top + 2 && t.top < h.y - 1).reduce((s, t) => s + overlapX(t.left, t.right, h.x0, h.x1), 0);
    if (covered > len * 0.25) continue;
    out.push({ type: 'line', left: h.x0, top, width: len, height: room });
  }
  for (const l of leaders) {
    const len = l.right - l.left;
    if (len < 15) continue;
    const height = Math.max(10, Math.min(18, l.height * 1.3));
    out.push({ type: 'line', left: l.left, top: l.baseline - height + 1, width: len, height });
  }

  // tira repetidos (mesma área detectada por dois caminhos) e ordena em ordem de leitura
  const final = [];
  for (const b of out) {
    if (final.some((f) => overlapX(f.left, f.left + f.width, b.left, b.left + b.width) > Math.min(f.width, b.width) * 0.6 &&
      overlapX(f.top, f.top + f.height, b.top, b.top + b.height) > Math.min(f.height, b.height) * 0.6)) continue;
    final.push(b);
  }
  // ordem de leitura: primeiro agrupa em fileiras (topos próximos), depois da esquerda para a direita
  // (comparação transitiva: o Safari ordena diferente do Chrome quando a regra é ambígua)
  final.sort((a, b) => a.top - b.top);
  let row = -1;
  let rowTop = -Infinity;
  for (const b of final) {
    if (b.top - rowTop > 4) { row++; rowTop = b.top; }
    b.row = row;
  }
  final.sort((a, b) => a.row - b.row || a.left - b.left);
  for (const b of final) b.key = key(b.type, b);
  return final;
}
