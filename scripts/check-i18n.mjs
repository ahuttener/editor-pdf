// Lista textos da interface (HTML e JS) que ainda não têm tradução para inglês
import fs from 'node:fs';
import { DICTIONARY } from '../app/js/i18n.js';

const has = (s) => Object.prototype.hasOwnProperty.call(DICTIONARY, s);
const found = new Map();
const add = (s, where) => { if (!found.has(s)) found.set(s, where); };

// HTML: textos e atributos visíveis
const html = fs.readFileSync('app/index.html', 'utf8').replace(/<script[\s\S]*?<\/script>/g, '').replace(/data-no-i18n[\s\S]*?>/g, '>');
for (const m of html.matchAll(/>([^<>]+)</g)) { const s = m[1].trim(); if (/[A-Za-zÀ-ú]/.test(s)) add(s, 'index.html'); }
for (const m of html.matchAll(/(?:title|placeholder|alt)="([^"]+)"/g)) add(m[1], 'index.html');

// JS: literais que parecem frase em português (têm espaço/acento e começam com letra)
const ignore = /^(app:|file:|pdf:|dir:|engine|font:|recent:|test:|shell:|print|data:|image\/|application\/|text\/|#|\.|\[|rgba?\(|M \d|editorpdf\.|Segoe|Arial|Times|Courier|Helvetica|cursive|selection:|object:|mouse:|path:|text:editing)/;
for (const file of ['app/js/app.js', 'app/js/features.js', 'app/js/dialogs.js', 'app/js/signature.js', 'app/js/textedit.js']) {
  const src = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  for (const m of src.matchAll(/(['"])((?:(?!\1)[^\\n]|\.)*)\1/g)) {
    const s = m[2].replace(/\'/g, "'").replace(/\\"/g, '"');
    if (s.length < 2 || ignore.test(s) || /[=;]|=>|\$\{/.test(s)) continue;
    if (!/[ àáâãçéêíóôõúÀ-Ú]/.test(s) || !/^[A-Za-zÀ-ú"'(⟲{.\-]/.test(s)) continue;
    add(s, file);
  }
}

const missing = [...found].filter(([s]) => !has(s) && !/^(PDF|CyberSecInfo|cybersecinfo\.com.*|Editor PDF|I|OK|Português|English|CÓPIA)$/.test(s));
if (missing.length) {
  console.log(`Sem tradução (${missing.length}):`);
  for (const [s, where] of missing) console.log(`  [${where}] ${s}`);
  process.exit(1);
}
console.log(`Tradução completa: ${found.size} textos conferidos.`);
