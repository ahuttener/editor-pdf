// Copia para public/ os arquivos de apoio do pdf.js (fontes padrão, cmaps, wasm) e as imagens da marca.
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pdfjs = path.join(root, 'node_modules', 'pdfjs-dist');
const out = path.join(root, 'public', 'pdfjs');
mkdirSync(out, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  cpSync(path.join(pdfjs, dir), path.join(out, dir), { recursive: true });
}
const desktop = path.join(root, '..');
mkdirSync(path.join(root, 'public', 'img'), { recursive: true });
cpSync(path.join(desktop, 'app', 'img', 'emblem.png'), path.join(root, 'public', 'img', 'emblem.png'));
cpSync(path.join(desktop, 'build', 'icon.png'), path.join(root, 'public', 'img', 'icon.png'));
console.log('assets ok');
