// Formulários: lê os campos do PDF original (pdf-lib), mostra campos HTML por cima das
// páginas e grava os valores preenchidos ao salvar.
import { PDFLib } from './libs.js';

const { PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } = PDFLib;

function fieldType(field) {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'list';
  return null; // botões e campos de assinatura digital ficam de fora
}

function readValue(field, type) {
  switch (type) {
    case 'text': return field.getText() ?? '';
    case 'checkbox': return field.isChecked();
    case 'radio': return field.getSelected() ?? null;
    case 'dropdown': return field.getSelected()[0] ?? '';
    case 'list': return field.getSelected()[0] ?? '';
    default: return null;
  }
}

export async function readFormFields(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  let form;
  try { form = doc.getForm(); } catch { return { fields: [], hasXFA: false }; }

  const pages = doc.getPages();
  const pageByRef = new Map(pages.map((p, i) => [p.ref.toString(), i]));
  const pageByAnnot = new Map();
  pages.forEach((p, i) => {
    const annots = p.node.Annots();
    if (!annots) return;
    for (let k = 0; k < annots.size(); k++) pageByAnnot.set(annots.get(k).toString(), i);
  });

  const fields = [];
  for (const field of form.getFields()) {
    const type = fieldType(field);
    if (!type) continue;
    const widgets = [];
    for (const w of field.acroField.getWidgets()) {
      const ref = doc.context.getObjectRef(w.dict);
      let pageIndex = ref ? pageByAnnot.get(ref.toString()) : undefined;
      if (pageIndex === undefined && w.P()) pageIndex = pageByRef.get(w.P().toString());
      if (pageIndex === undefined) continue;
      const r = w.getRectangle();
      let onValue = null;
      try { onValue = w.getOnValue()?.decodeText() ?? null; } catch { /* sem valor "ligado" */ }
      widgets.push({ pageIndex, rect: [r.x, r.y, r.x + r.width, r.y + r.height], onValue });
    }
    if (!widgets.length) continue;
    const value = readValue(field, type);
    fields.push({
      name: field.getName(),
      type,
      widgets,
      value,
      original: JSON.stringify(value),
      options: type === 'dropdown' || type === 'list' ? field.getOptions() : null,
      multiline: type === 'text' ? field.isMultiline() : false,
      maxLength: type === 'text' ? field.getMaxLength() : undefined,
      readOnly: field.isReadOnly(),
      inputs: [],
    });
  }
  return { fields, hasXFA: form.hasXFA() };
}

export async function applyFormValues(out, fields, getFont) {
  const changed = fields.filter((f) => JSON.stringify(f.value) !== f.original);
  if (!changed.length) return;
  const form = out.getForm();
  for (const fd of changed) {
    let field;
    try { field = form.getField(fd.name); } catch { continue; }
    switch (fd.type) {
      case 'text': field.setText(fd.value ? String(fd.value) : undefined); break;
      case 'checkbox': fd.value ? field.check() : field.uncheck(); break;
      case 'radio': fd.value ? field.select(fd.value) : field.clear(); break;
      case 'dropdown':
      case 'list': fd.value ? field.select(fd.value) : field.clear(); break;
    }
  }
  if (form.hasXFA()) form.deleteXFA(); // senão leitores com XFA ignoram os valores novos
  form.updateFieldAppearances(await getFont());
}

// Desenha os campos de uma página (só páginas do documento principal têm campos editáveis)
export function renderFormLayer(entry, fields, zoom, onChange) {
  const layer = entry.formLayer;
  layer.replaceChildren();
  if (entry.docKey !== 'main') return;
  const vp = entry.viewport();
  for (const fd of fields) {
    fd.inputs = fd.inputs.filter((el) => el.isConnected && el.parentNode !== layer);
    fd.widgets.forEach((w) => {
      if (w.pageIndex !== entry.index) return;
      const [x1, y1] = vp.convertToViewportPoint(w.rect[0], w.rect[1]);
      const [x2, y2] = vp.convertToViewportPoint(w.rect[2], w.rect[3]);
      const left = Math.min(x1, x2) * zoom;
      const top = Math.min(y1, y2) * zoom;
      const width = Math.abs(x2 - x1) * zoom;
      const height = Math.abs(y2 - y1) * zoom;
      const el = createInput(fd, w, height);
      Object.assign(el.style, { left: `${left}px`, top: `${top}px` });
      if (fd.type === 'checkbox' || fd.type === 'radio') {
        const size = Math.max(10, Math.min(width, height) * 0.8);
        Object.assign(el.style, { width: `${size}px`, height: `${size}px`, left: `${left + (width - size) / 2}px`, top: `${top + (height - size) / 2}px` });
      } else {
        Object.assign(el.style, { width: `${width}px`, height: `${height}px` });
      }
      el.disabled = fd.readOnly;
      el.title = fd.name;
      const sync = () => {
        fd.value = readInput(fd, el);
        for (const other of fd.inputs) if (other !== el) writeInput(fd, other);
        onChange(fd);
      };
      el.addEventListener(fd.type === 'text' ? 'input' : 'change', sync);
      fd.inputs.push(el);
      layer.append(el);
    });
  }
}

function createInput(fd, widget, height) {
  let el;
  if (fd.type === 'text') {
    el = fd.multiline ? document.createElement('textarea') : document.createElement('input');
    if (!fd.multiline) el.type = 'text';
    if (fd.maxLength) el.maxLength = fd.maxLength;
    el.style.fontSize = `${Math.max(8, Math.min(fd.multiline ? 14 : height * 0.68, 22))}px`;
  } else if (fd.type === 'checkbox' || fd.type === 'radio') {
    el = document.createElement('input');
    el.type = fd.type;
    if (fd.type === 'radio') { el.name = `radio:${fd.name}`; el.value = widget.onValue ?? ''; }
  } else {
    el = document.createElement('select');
    el.append(new Option('', ''));
    for (const opt of fd.options || []) el.append(new Option(opt, opt));
    el.style.fontSize = `${Math.max(8, Math.min(height * 0.62, 18))}px`;
  }
  el.dataset.widget = widget.onValue ?? '';
  writeInput(fd, el);
  return el;
}

function readInput(fd, el) {
  if (fd.type === 'checkbox') return el.checked;
  if (fd.type === 'radio') return el.checked ? el.value : fd.value;
  return el.value;
}

function writeInput(fd, el) {
  if (fd.type === 'checkbox') el.checked = !!fd.value;
  else if (fd.type === 'radio') el.checked = fd.value !== null && el.value === fd.value;
  else el.value = fd.value ?? '';
}
