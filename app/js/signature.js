// Assinatura: desenhar, digitar (fonte manuscrita do sistema) ou reutilizar uma salva.
import { t } from './i18n.js';
const $ = (sel) => document.querySelector(sel);
const STORE_KEY = 'editorpdf.assinaturas';

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]').filter((s) => typeof s === 'string'); } catch { return []; }
}
function storeSaved(list) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 6))); } catch { /* armazenamento indisponível */ }
}

export function trimCanvas(canvas, pad = 6) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d').drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

export function signatureDialog(scriptFonts) {
  return new Promise((resolve) => {
    const modal = $('#sig-modal');
    const drawCanvas = $('#sig-canvas');
    const typeCanvas = $('#sig-type-canvas');
    const dctx = drawCanvas.getContext('2d');
    dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    let mode = 'draw';
    let drew = false;
    let drawing = false;
    let last = null;
    let pickedSaved = null;
    const saved = loadSaved();

    const fontSelect = $('#sig-font');
    fontSelect.replaceChildren(...(scriptFonts.length ? scriptFonts : ['cursive']).map((f) => {
      const o = new Option(f === 'cursive' ? t('Cursiva') : f, f);
      o.style.fontFamily = f;
      return o;
    }));

    const setMode = (m) => {
      mode = m;
      for (const b of document.querySelectorAll('#sig-tabs .seg-btn')) b.classList.toggle('active', b.dataset.sig === m);
      for (const p of document.querySelectorAll('.sig-pane')) p.hidden = p.dataset.sigPane !== m;
      $('#sig-remember').parentElement.hidden = m === 'saved';
      if (m === 'type') { renderTyped(); $('#sig-name').focus(); }
      if (m === 'saved') renderSaved();
    };

    const renderTyped = () => {
      const ctx = typeCanvas.getContext('2d');
      ctx.clearRect(0, 0, typeCanvas.width, typeCanvas.height);
      const name = $('#sig-name').value.trim();
      if (!name) return;
      let size = 72;
      ctx.fillStyle = $('#sig-type-color').value;
      ctx.textBaseline = 'middle';
      do {
        ctx.font = `${size}px "${fontSelect.value}", cursive`;
        size -= 4;
      } while (ctx.measureText(name).width > typeCanvas.width - 40 && size > 20);
      ctx.fillText(name, 20, typeCanvas.height / 2);
    };

    const renderSaved = () => {
      const box = $('#sig-saved');
      box.replaceChildren();
      if (!saved.length) {
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = t('Nenhuma assinatura guardada ainda.');
        box.append(p);
        return;
      }
      saved.forEach((src, i) => {
        const item = document.createElement('div');
        item.className = 'item' + (pickedSaved === src ? ' active' : '');
        const img = document.createElement('img');
        img.src = src;
        img.alt = t('Assinatura salva');
        const del = document.createElement('button');
        del.className = 'del';
        del.textContent = '✕';
        del.title = t('Apagar');
        del.onclick = (e) => { e.stopPropagation(); saved.splice(i, 1); storeSaved(saved); if (pickedSaved === src) pickedSaved = null; renderSaved(); };
        item.onclick = () => { pickedSaved = src; renderSaved(); };
        item.ondblclick = () => { pickedSaved = src; finish(); };
        item.append(img, del);
        box.append(item);
      });
    };

    const pos = (e) => {
      const r = drawCanvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (drawCanvas.width / r.width), y: (e.clientY - r.top) * (drawCanvas.height / r.height) };
    };
    const down = (e) => { drawing = true; last = pos(e); drawCanvas.setPointerCapture(e.pointerId); };
    const move = (e) => {
      if (!drawing) return;
      const p = pos(e);
      dctx.strokeStyle = $('#sig-color').value;
      dctx.lineWidth = 3;
      dctx.lineCap = 'round';
      dctx.lineJoin = 'round';
      dctx.beginPath();
      dctx.moveTo(last.x, last.y);
      dctx.lineTo(p.x, p.y);
      dctx.stroke();
      last = p;
      drew = true;
    };
    const up = () => { drawing = false; };

    const cleanup = () => {
      modal.hidden = true;
      drawCanvas.removeEventListener('pointerdown', down);
      drawCanvas.removeEventListener('pointermove', move);
      drawCanvas.removeEventListener('pointerup', up);
      for (const b of document.querySelectorAll('#sig-tabs .seg-btn')) b.onclick = null;
      $('#sig-clear').onclick = $('#sig-cancel').onclick = $('#sig-ok').onclick = null;
      $('#sig-name').oninput = fontSelect.onchange = $('#sig-type-color').oninput = null;
      document.removeEventListener('keydown', onKey, true);
    };
    const finish = () => {
      let result = null;
      if (mode === 'draw' && drew) result = trimCanvas(drawCanvas);
      else if (mode === 'type' && $('#sig-name').value.trim()) { renderTyped(); result = trimCanvas(typeCanvas); }
      else if (mode === 'saved') result = pickedSaved;
      if (!result) return;
      if (mode !== 'saved' && $('#sig-remember').checked && !saved.includes(result)) { saved.unshift(result); storeSaved(saved); }
      cleanup();
      resolve(result);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); cleanup(); resolve(null); } };

    drawCanvas.addEventListener('pointerdown', down);
    drawCanvas.addEventListener('pointermove', move);
    drawCanvas.addEventListener('pointerup', up);
    for (const b of document.querySelectorAll('#sig-tabs .seg-btn')) b.onclick = () => setMode(b.dataset.sig);
    $('#sig-clear').onclick = () => { dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height); drew = false; };
    $('#sig-cancel').onclick = () => { cleanup(); resolve(null); };
    $('#sig-ok').onclick = finish;
    $('#sig-name').oninput = renderTyped;
    fontSelect.onchange = renderTyped;
    $('#sig-type-color').oninput = renderTyped;
    document.addEventListener('keydown', onKey, true);
    modal.hidden = false;
    setMode(saved.length ? 'saved' : 'draw');
  });
}
