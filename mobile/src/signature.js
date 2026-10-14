// Assinatura desenhada com o dedo; a última fica guardada no aparelho para reaproveitar.
import { t } from './i18n.js';
import { icon } from './icons.js';
import { sheet, $ } from './ui.js';

const KEY = 'editorpdf.assinatura';

export function savedSignature() {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

export function clearSignature() {
  try { localStorage.removeItem(KEY); } catch {}
}

// Recorta as bordas vazias do desenho
function trim(canvas, pad = 8) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

function drawPad(resolve) {
  const colors = ['#111827', '#1c4a82'];
  let color = colors[0];
  const s = sheet(`<div class="sig-pad"><canvas></canvas><span class="sig-line"></span><span class="sig-hint">${t('Desenhe sua assinatura')}</span></div>
    <div class="sig-tools">
      ${colors.map((c, i) => `<button class="swatch ${i === 0 ? 'on' : ''}" style="--c:${c}" data-color="${c}" aria-label="${t('Cor')}"></button>`).join('')}
      <span class="grow"></span>
      <button class="btn btn-text" data-clear>${t('Limpar')}</button>
    </div>
    <div class="sheet-actions"><button class="btn btn-primary" data-use disabled>${t('Usar assinatura')}</button></div>`,
  { title: t('Assinatura'), onClose: (v) => resolve(v || null) });

  const pad = $('.sig-pad', s.el);
  const canvas = $('canvas', pad);
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const size = () => {
    const r = pad.getBoundingClientRect();
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
  };
  requestAnimationFrame(size);
  const ctx = canvas.getContext('2d');
  let drawing = false, last = null, has = false;
  const useBtn = $('[data-use]', s.el);
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr };
  };
  canvas.addEventListener('pointerdown', (e) => {
    drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId);
    pad.classList.add('inked');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.6 * dpr;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.quadraticCurveTo(last.x, last.y, (last.x + p.x) / 2, (last.y + p.y) / 2);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
    if (!has) { has = true; useBtn.disabled = false; }
  });
  const end = () => { drawing = false; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  $('[data-clear]', s.el).addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    has = false; useBtn.disabled = true; pad.classList.remove('inked');
  });
  s.el.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => {
    color = b.dataset.color;
    s.el.querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('on', x === b));
  }));
  useBtn.addEventListener('click', () => {
    const url = trim(canvas);
    if (!url) return;
    try { localStorage.setItem(KEY, url); } catch {}
    s.close(url);
  });
}

// Devolve o dataURL PNG da assinatura escolhida, ou null
export function chooseSignature() {
  return new Promise((resolve) => {
    const saved = savedSignature();
    if (!saved) return drawPad(resolve);
    const s = sheet(`<button class="sig-saved" data-use><img src="${saved}" alt="${t('Assinatura salva')}"></button>
      <div class="sheet-actions">
        <button class="btn btn-primary" data-use>${t('Usar assinatura')}</button>
        <button class="btn btn-secondary" data-new>${icon('pen', { size: 18 })}<span>${t('Nova assinatura')}</span></button>
      </div>`, { title: t('Assinatura'), onClose: (v) => { if (v !== 'new') resolve(v || null); } });
    s.el.querySelectorAll('[data-use]').forEach((b) => b.addEventListener('click', () => s.close(saved)));
    $('[data-new]', s.el).addEventListener('click', () => { s.close('new'); setTimeout(() => drawPad(resolve), 230); });
  });
}
