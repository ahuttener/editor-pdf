// Copia para public/ os arquivos de apoio do pdf.js (fontes padrão, cmaps, wasm) e as imagens da marca.
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
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
// Motor (OCR): worker e núcleo do Tesseract, dados de português e inglês, fonte da camada de texto
const engine = path.join(root, 'public', 'engine');
const rootModules = path.join(desktop, 'node_modules');
mkdirSync(path.join(engine, 'tessdata'), { recursive: true });
mkdirSync(path.join(engine, 'core'), { recursive: true });
cpSync(path.join(rootModules, 'tesseract.js', 'dist', 'worker.min.js'), path.join(engine, 'tesseract-worker.min.js'));
for (const v of ['lstm', 'simd-lstm', 'relaxedsimd-lstm']) {
  cpSync(path.join(rootModules, 'tesseract.js-core', `tesseract-core-${v}.wasm.js`), path.join(engine, 'core', `tesseract-core-${v}.wasm.js`));
}
// Descompactados: o empacotador do Android tira o .gz dos assets (o arquivo chegaria com outro nome)
for (const lang of ['por', 'eng']) {
  rmSync(path.join(engine, 'tessdata', `${lang}.traineddata.gz`), { force: true });
  writeFileSync(path.join(engine, 'tessdata', `${lang}.traineddata`), gunzipSync(readFileSync(path.join(desktop, 'vendor', 'tessdata', `${lang}.traineddata.gz`))));
}
cpSync(path.join(pdfjs, 'standard_fonts', 'LiberationSans-Regular.ttf'), path.join(engine, 'LiberationSans-Regular.ttf'));
console.log('assets ok');
