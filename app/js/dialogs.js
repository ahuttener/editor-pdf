// Diálogos do app, montados com DOM (sem innerHTML com dados do usuário).
import { t } from './i18n.js';
const $ = (sel) => document.querySelector(sel);

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

// Campos: { name, label, type: text|password|number|select|textarea|checkbox|color|note, value, options, min, max, step, placeholder }
function renderField(f) {
  if (f.type === 'note') return el('p', { class: 'dialog-note', text: t(f.text) });
  if (f.type === 'row') return el('div', { class: 'field-row' }, f.fields.map(renderField));
  if (f.type === 'checkbox') {
    return el('label', { class: 'check-row' }, [
      el('input', { type: 'checkbox', name: f.name, checked: !!f.value }),
      document.createTextNode(t(f.label)),
    ]);
  }
  let input;
  if (f.type === 'select') {
    input = el('select', { name: f.name });
    for (const [value, label] of f.options) input.append(el('option', { value, text: t(label), selected: String(value) === String(f.value) }));
  } else if (f.type === 'textarea') {
    input = el('textarea', { name: f.name, placeholder: f.placeholder, rows: f.rows || 3 });
    input.value = f.value ?? '';
  } else {
    input = el('input', {
      type: f.type || 'text', name: f.name, min: f.min, max: f.max, step: f.step, placeholder: f.placeholder,
      autocomplete: f.type === 'password' ? 'new-password' : 'off',
    });
    input.value = f.value ?? '';
  }
  return el('label', { class: 'field' }, [document.createTextNode(t(f.label || '')), input]);
}

let openDialogs = 0;
export const isDialogOpen = () => openDialogs > 0;

// Mostra um diálogo e devolve os valores (ou null se cancelar).
// validate(values) pode devolver uma mensagem de erro para manter o diálogo aberto.
export function formDialog({ title, fields = [], ok = 'OK', cancel = 'Cancelar', alt = null, validate, body }) {
  return new Promise((resolve) => {
    const modal = $('#dialog');
    const form = $('#dialog-form');
    $('#dialog-title').textContent = t(title);
    const bodyEl = $('#dialog-body');
    bodyEl.replaceChildren(...(body ? [body] : []), ...fields.map(renderField), el('div', { class: 'dialog-error', id: 'dialog-error' }));
    const actions = $('#dialog-actions');
    const cancelBtn = cancel ? el('button', { type: 'button', class: 'btn', text: t(cancel) }) : null;
    const okBtn = ok ? el('button', { type: 'submit', class: 'btn primary', text: t(ok) }) : null;
    const altBtn = alt ? el('button', { type: 'button', class: 'btn', text: t(alt) }) : null;
    actions.replaceChildren(...[cancelBtn, altBtn, okBtn].filter(Boolean));

    const values = () => {
      const out = {};
      for (const input of form.querySelectorAll('[name]')) {
        if (input.type === 'checkbox') out[input.name] = input.checked;
        else if (input.type === 'number') out[input.name] = input.value === '' ? null : Number(input.value);
        else out[input.name] = input.value;
      }
      return out;
    };
    const close = (result) => {
      modal.hidden = true;
      openDialogs--;
      form.onsubmit = null;
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); } };
    form.onsubmit = (e) => {
      e.preventDefault();
      const v = values();
      const err = validate?.(v);
      if (err) { $('#dialog-error').textContent = t(err); return; }
      close(v);
    };
    cancelBtn?.addEventListener('click', () => close(null));
    altBtn?.addEventListener('click', () => close({ __alt: true }));
    document.addEventListener('keydown', onKey, true);
    openDialogs++;
    modal.hidden = false;
    (form.querySelector('input:not([type=checkbox]), select, textarea') || okBtn)?.focus();
  });
}

export async function confirmDialog(title, message, ok = 'Continuar', cancel = 'Cancelar') {
  const r = await formDialog({ title, fields: [{ type: 'note', text: message }], ok, cancel });
  return r !== null;
}

// Devolve 'ok', 'alt' ou null (cancelar/Esc)
export async function choiceDialog(title, message, ok, alt) {
  const r = await formDialog({ title, fields: [{ type: 'note', text: message }], ok, alt });
  if (!r) return null;
  return r.__alt ? 'alt' : 'ok';
}

export function infoDialog(title, message, body) {
  return formDialog({ title, fields: message ? [{ type: 'note', text: message }] : [], body, ok: 'Fechar', cancel: null });
}

export function askPassword(message, title = 'PDF protegido') {
  return formDialog({
    title,
    fields: [{ type: 'note', text: message }, { name: 'password', label: 'Senha', type: 'password' }],
    ok: 'Abrir',
  }).then((v) => (v ? v.password : null));
}

export function passwordDialog(current) {
  return formDialog({
    title: 'Senha e permissões',
    fields: [
      { type: 'note', text: 'O PDF salvo vai pedir a senha para abrir (criptografia AES-256).' },
      { name: 'user', label: 'Senha para abrir', type: 'password', value: current?.user || '' },
      { name: 'confirm', label: 'Repita a senha', type: 'password', value: current?.user || '' },
      { type: 'note', text: 'Restrições (opcional) — valem para quem abrir com a senha acima:' },
      { name: 'noPrint', label: 'Impedir impressão', type: 'checkbox', value: current?.noPrint },
      { name: 'noCopy', label: 'Impedir copiar texto e imagens', type: 'checkbox', value: current?.noCopy },
      { name: 'noEdit', label: 'Impedir edição', type: 'checkbox', value: current?.noEdit },
      { name: 'owner', label: 'Senha do proprietário (libera as restrições)', type: 'password', value: current?.owner || '' },
    ],
    ok: 'Aplicar ao salvar',
    validate: (v) => {
      if (!v.user) return 'Digite a senha.';
      if (v.user !== v.confirm) return 'As senhas não conferem.';
      if (/,/.test(v.user + v.owner)) return 'A senha não pode ter vírgula.';
      if ((v.noPrint || v.noCopy || v.noEdit) && !v.owner) return 'Para usar restrições, defina a senha do proprietário.';
      if (v.owner && v.owner === v.user) return 'A senha do proprietário precisa ser diferente.';
      return null;
    },
  });
}

export function watermarkDialog(defaults) {
  return formDialog({
    title: "Marca d'água",
    fields: [
      { name: 'text', label: 'Texto', value: defaults.text || 'CONFIDENCIAL' },
      { type: 'row', fields: [
        { name: 'size', label: 'Tamanho', type: 'number', min: 8, max: 200, value: defaults.size || 60 },
        { name: 'angle', label: 'Ângulo', type: 'number', min: -90, max: 90, value: defaults.angle ?? -35 },
        { name: 'opacity', label: 'Opacidade (%)', type: 'number', min: 5, max: 100, value: defaults.opacity || 18 },
      ] },
      { type: 'row', fields: [
        { name: 'color', label: 'Cor', type: 'color', value: defaults.color || '#c62828' },
        { name: 'font', label: 'Fonte', type: 'select', value: defaults.font || 'Arial', options: defaults.fonts.map((f) => [f, f]) },
      ] },
      { name: 'useLogo', label: 'Usar o meu logo em vez do texto', type: 'checkbox', value: false },
      { name: 'remove', label: "Remover a marca d'água existente", type: 'checkbox', value: false },
    ],
    ok: 'Aplicar em todas as páginas',
  });
}

export function headerFooterDialog(defaults) {
  return formDialog({
    title: 'Cabeçalho e rodapé',
    fields: [
      { type: 'note', text: 'Use {n} para o número da página, {total} para o total, {data} para a data e {arquivo} para o nome do arquivo.' },
      { type: 'row', fields: [
        { name: 'tl', label: 'Cabeçalho — esquerda', value: defaults.tl || '' },
        { name: 'tc', label: 'Centro', value: defaults.tc || '' },
        { name: 'tr', label: 'Direita', value: defaults.tr || '' },
      ] },
      { type: 'row', fields: [
        { name: 'bl', label: 'Rodapé — esquerda', value: defaults.bl || '' },
        { name: 'bc', label: 'Centro', value: defaults.bc ?? t('Página {n} de {total}') },
        { name: 'br', label: 'Direita', value: defaults.br || '' },
      ] },
      { type: 'row', fields: [
        { name: 'size', label: 'Tamanho', type: 'number', min: 6, max: 30, value: defaults.size || 9 },
        { name: 'margin', label: 'Margem (pt)', type: 'number', min: 8, max: 80, value: defaults.margin || 22 },
        { name: 'color', label: 'Cor', type: 'color', value: defaults.color || '#444444' },
      ] },
      { name: 'start', label: 'Começar a numeração em', type: 'number', min: 0, max: 9999, value: defaults.start ?? 1 },
      { name: 'skipFirst', label: 'Não colocar na primeira página', type: 'checkbox', value: defaults.skipFirst },
      { name: 'remove', label: 'Remover cabeçalho e rodapé existentes', type: 'checkbox', value: false },
    ],
    ok: 'Aplicar',
  });
}

export function propertiesDialog(meta) {
  return formDialog({
    title: 'Propriedades do documento',
    fields: [
      { name: 'title', label: 'Título', value: meta.title || '' },
      { name: 'author', label: 'Autor', value: meta.author || '' },
      { name: 'subject', label: 'Assunto', value: meta.subject || '' },
      { name: 'keywords', label: 'Palavras-chave (separadas por vírgula)', value: meta.keywords || '' },
      { name: 'lang', label: 'Idioma do documento (leitores de tela)', type: 'select', value: meta.lang || '', options: [
        ['', 'Não definido'], ['pt-BR', 'Português (Brasil)'], ['pt-PT', 'Português (Portugal)'], ['en-US', 'Inglês (EUA)'], ['en-GB', 'Inglês (Reino Unido)'], ['es', 'Espanhol'],
      ] },
    ],
    ok: 'Aplicar ao salvar',
  });
}

export function compressDialog(sizeText) {
  return formDialog({
    title: 'Comprimir PDF',
    fields: [
      { type: 'note', text: t('Tamanho atual: {tamanho}. O resultado é salvo como um novo arquivo.', { tamanho: sizeText }) },
      { name: 'level', label: 'Nível', type: 'select', value: 'medium', options: [
        ['low', 'Leve — melhor qualidade das imagens'],
        ['medium', 'Recomendado — equilíbrio'],
        ['high', 'Forte — menor arquivo'],
      ] },
    ],
    ok: 'Comprimir e salvar',
  });
}

export function splitDialog(total) {
  return formDialog({
    title: 'Dividir PDF',
    fields: [
      { name: 'mode', label: 'Como dividir', type: 'select', value: 'every', options: [
        ['every', 'A cada N páginas'],
        ['ranges', 'Por intervalos (ex.: 1-3, 4, 5-8)'],
        ['each', 'Uma página por arquivo'],
      ] },
      { name: 'every', label: 'N (páginas por arquivo)', type: 'number', min: 1, max: total, value: Math.min(2, total) },
      { name: 'ranges', label: 'Intervalos', placeholder: `1-${Math.ceil(total / 2)}, ${Math.ceil(total / 2) + 1}-${total}` },
    ],
    ok: 'Dividir e salvar',
  });
}

export function imagesExportDialog() {
  return formDialog({
    title: 'PDF → Imagens',
    fields: [
      { type: 'row', fields: [
        { name: 'format', label: 'Formato', type: 'select', value: 'png', options: [['png', 'PNG'], ['jpg', 'JPG']] },
        { name: 'dpi', label: 'Qualidade (DPI)', type: 'select', value: '150', options: [['96', '96 (tela)'], ['150', '150 (padrão)'], ['300', '300 (impressão)']] },
      ] },
      { name: 'which', label: 'Páginas', type: 'select', value: 'all', options: [['all', 'Todas'], ['selected', 'Só as selecionadas']] },
    ],
    ok: 'Escolher pasta e salvar',
  });
}

export function ocrDialog(total) {
  return formDialog({
    title: 'OCR — reconhecer texto',
    fields: [
      { type: 'note', text: 'Lê o texto de páginas escaneadas (português e inglês) e o grava de forma invisível: o PDF fica pesquisável, copiável e editável com "Editar texto". Tudo é feito no seu computador.' },
      { name: 'which', label: 'Páginas', type: 'select', value: 'all', options: [['all', t('Todas ({n})', { n: total })], ['selected', 'Só as selecionadas']] },
      { name: 'force', label: 'Ler também páginas que já têm texto', type: 'checkbox', value: false },
    ],
    ok: 'Reconhecer',
  });
}

export function fieldDialog(type, suggested) {
  const fields = [{ name: 'name', label: 'Nome do campo', value: suggested }];
  if (type === 'list') fields.push({ name: 'options', label: 'Opções (uma por linha)', type: 'textarea', value: 'Opção 1\nOpção 2\nOpção 3', rows: 4 });
  if (type === 'text') fields.push({ name: 'multiline', label: 'Várias linhas', type: 'checkbox', value: false });
  fields.push({ name: 'required', label: 'Preenchimento obrigatório', type: 'checkbox', value: false });
  return formDialog({
    title: { text: 'Novo campo de texto', check: 'Nova caixa de marcar', list: 'Nova lista de opções' }[type],
    fields,
    ok: 'Criar',
    validate: (v) => {
      if (!v.name.trim()) return 'Dê um nome ao campo.';
      if (/[.]/.test(v.name)) return 'O nome não pode ter ponto.';
      if (type === 'list' && !v.options.split('\n').some((o) => o.trim())) return 'Informe pelo menos uma opção.';
      return null;
    },
  });
}

export function aboutDialog(version) {
  const body = el('div', { class: 'about' }, [
    el('img', { src: 'img/emblem.png', alt: 'CyberSecInfo' }),
    el('h3', { text: `Editor PDF ${version}` }),
    el('p', { class: 'muted', text: t('por CyberSecInfo — Information Security') }),
    el('p', { class: 'brand-line', text: 'cybersecinfo.com · @cybersecinfo' }),
    el('p', { class: 'dialog-note', text: t('Usa componentes de código aberto: pdf.js (Apache-2.0), fabric.js (MIT), pdf-lib (MIT), MuPDF (AGPL-3.0), Tesseract (Apache-2.0), docx (MIT), Electron (MIT).') }),
  ]);
  return infoDialog('Sobre', null, body);
}

export { el };
