// Peças de interface reaproveitadas: painel inferior, confirmação, pergunta, aviso e carregando.
import { t, getLang } from './i18n.js';
import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function h(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

// Painel que sobe da parte de baixo. Devolve { el, close }; onClose roda uma vez.
export function sheet(content, { title = '', onClose } = {}) {
  const root = h(`<div class="sheet-root" role="dialog" aria-modal="true">
    <div class="sheet-backdrop"></div>
    <div class="sheet">
      <div class="sheet-grip"></div>
      ${title ? `<div class="sheet-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="${esc(t('Fechar'))}">${icon('close')}</button></div>` : ''}
      <div class="sheet-body"></div>
    </div>
  </div>`);
  const body = $('.sheet-body', root);
  if (typeof content === 'string') body.innerHTML = content; else body.append(content);
  document.body.append(root);
  requestAnimationFrame(() => root.classList.add('open'));
  let closed = false;
  const close = (value) => {
    if (closed) return;
    closed = true;
    root.classList.remove('open');
    setTimeout(() => root.remove(), 220);
    onClose?.(value);
  };
  $('.sheet-backdrop', root).addEventListener('click', () => close());
  root.querySelector('[data-close]')?.addEventListener('click', () => close());
  return { el: root, body, close };
}

export function confirmSheet({ title, text, ok, cancel = t('Cancelar'), danger = false }) {
  return new Promise((resolve) => {
    const s = sheet(`<p class="sheet-text">${esc(text)}</p>
      <div class="sheet-actions">
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(ok)}</button>
        <button class="btn btn-secondary" data-cancel>${esc(cancel)}</button>
      </div>`, { title, onClose: (v) => resolve(!!v) });
    $('[data-ok]', s.el).addEventListener('click', () => s.close(true));
    $('[data-cancel]', s.el).addEventListener('click', () => s.close(false));
  });
}

export function promptSheet({ title, label, value = '', ok = t('Salvar') }) {
  return new Promise((resolve) => {
    const s = sheet(`<label class="field"><span>${esc(label)}</span><input type="text" value="${esc(value)}" autocomplete="off"></label>
      <div class="sheet-actions"><button class="btn btn-primary" data-ok>${esc(ok)}</button></div>`, { title, onClose: (v) => resolve(v ?? null) });
    const input = $('input', s.el);
    setTimeout(() => { input.focus(); input.select(); }, 250);
    const done = () => s.close(input.value.trim() || null);
    $('[data-ok]', s.el).addEventListener('click', done);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
  });
}

let toastTimer;
export function toast(text, kind = '') {
  let el = $('#toast');
  if (!el) { el = h('<div id="toast" role="status" aria-live="polite"></div>'); document.body.append(el); }
  el.className = `toast show ${kind}`;
  el.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

export function busy(text) {
  const el = h(`<div class="busy" role="status"><div class="busy-card"><div class="spinner"></div><span>${esc(text)}</span></div></div>`);
  document.body.append(el);
  return () => el.remove();
}

// Seletor de arquivo do sistema (funciona no Android, iOS e navegador)
export function pickFiles({ accept, multiple = false }) {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept, multiple });
    input.style.display = 'none';
    document.body.append(input);
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); }, { once: true });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); }, { once: true });
    input.click();
  });
}

export function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

export function formatWhen(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  const loc = getLang() === 'en' ? 'en-GB' : 'pt-BR';
  const time = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  if (same(d, today)) return `${t('hoje')}, ${time}`;
  if (same(d, y)) return `${t('ontem')}, ${time}`;
  return d.toLocaleDateString(loc);
}

export const pagesLabel = (n) => (n === 1 ? t('1 página') : t('{n} páginas', { n }));
