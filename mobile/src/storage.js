// Biblioteca local: os PDFs ficam na pasta privada do app; a lista (nome, páginas, miniatura) no localStorage.
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Browser } from '@capacitor/browser';

const LIST_KEY = 'editorpdf.biblioteca';
const DIR = 'biblioteca';

export function toBase64(bytes) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  return btoa(bin);
}

export function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function readList() {
  try {
    const list = JSON.parse(localStorage.getItem(LIST_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function writeList(list) {
  try { localStorage.setItem(LIST_KEY, JSON.stringify(list)); } catch {}
}

export const listDocs = () => readList().sort((a, b) => b.updated - a.updated);

// Nome de arquivo seguro, sempre terminando em .pdf
export function cleanName(name) {
  const base = String(name || 'documento').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'documento';
  return `${base}.pdf`;
}

export async function saveDoc({ id, name, bytes, pages, thumb }) {
  const list = readList();
  const docId = id || `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const file = `${DIR}/${docId}.pdf`;
  await Filesystem.writeFile({ path: file, data: toBase64(bytes), directory: Directory.Data, recursive: true });
  const meta = { id: docId, name: cleanName(name), file, size: bytes.length, pages, thumb, updated: Date.now() };
  const i = list.findIndex((d) => d.id === docId);
  if (i >= 0) list[i] = { ...list[i], ...meta }; else list.push(meta);
  writeList(list);
  return meta;
}

export async function readDoc(meta) {
  const { data } = await Filesystem.readFile({ path: meta.file, directory: Directory.Data });
  return typeof data === 'string' ? fromBase64(data) : new Uint8Array(await data.arrayBuffer());
}

export async function deleteDoc(meta) {
  try { await Filesystem.deleteFile({ path: meta.file, directory: Directory.Data }); } catch {}
  writeList(readList().filter((d) => d.id !== meta.id));
}

export function renameDoc(meta, name) {
  const list = readList();
  const d = list.find((x) => x.id === meta.id);
  if (d) { d.name = cleanName(name); writeList(list); }
  return d;
}

// Compartilhar gera uma cópia com o nome visível (o arquivo interno usa o id)
export async function shareDoc(meta) {
  const bytes = await readDoc(meta);
  if (!Capacitor.isNativePlatform()) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: meta.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return;
  }
  const path = `compartilhar/${meta.name}`;
  await Filesystem.writeFile({ path, data: toBase64(bytes), directory: Directory.Cache, recursive: true });
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
  await Share.share({ title: meta.name, files: [uri], dialogTitle: meta.name });
}

// Compartilha arquivos gerados na hora (Word, imagens, texto): [{ name, bytes, mime }]
export async function shareFiles(files, title = '') {
  if (!Capacitor.isNativePlatform()) {
    for (const f of files) {
      const url = URL.createObjectURL(new Blob([f.bytes], { type: f.mime }));
      Object.assign(document.createElement('a'), { href: url, download: f.name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }
    return;
  }
  const stamp = Date.now().toString(36);
  const uris = [];
  for (const f of files) {
    const path = `compartilhar/${stamp}/${f.name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')}`;
    await Filesystem.writeFile({ path, data: toBase64(f.bytes), directory: Directory.Cache, recursive: true });
    uris.push((await Filesystem.getUri({ path, directory: Directory.Cache })).uri);
  }
  await Share.share({ title: title || files[0].name, files: uris, dialogTitle: title || files[0].name });
}

// Imprimir: tela de impressão do sistema (plugin nativo plugins/print); no navegador, a do próprio navegador
const Printer = registerPlugin('Printer');
export async function printPdf(bytes, name = 'Documento') {
  if (Capacitor.isNativePlatform()) return Printer.printPdf({ data: toBase64(bytes), name });
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const frame = Object.assign(document.createElement('iframe'), { src: url, style: 'position:fixed;width:0;height:0;border:0' });
  frame.onload = () => { frame.contentWindow.print(); setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 60000); };
  document.body.append(frame);
}

export async function openExternal(url) {
  if (!/^https:\/\//.test(url)) return;
  if (Capacitor.isNativePlatform()) await Browser.open({ url });
  else window.open(url, '_blank', 'noopener');
}
