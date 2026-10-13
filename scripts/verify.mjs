// Confere o PDF salvo pelo autoteste: ordem das páginas, textos, rotação e formulário.
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || 'test-output');
const report = JSON.parse(await fs.readFile(path.join(dir, 'report.json'), 'utf8'));
const bytes = new Uint8Array(await fs.readFile(path.join(dir, 'saida.pdf')));

const checks = [];
const check = (name, ok, info) => checks.push({ name, ok: !!ok, info });

const pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
const texts = [];
const rotations = [];
for (let i = 1; i <= pdf.numPages; i++) {
  const page = await pdf.getPage(i);
  rotations.push(page.rotate);
  const tc = await page.getTextContent();
  texts.push(tc.items.map((it) => it.str).join(' | '));
}

check('3 páginas', pdf.numPages === 3, pdf.numPages);
check('página 1 é o anexo', texts[0]?.includes('ANEXO I'), texts[0]);
check('página 2 tem o valor novo', texts[1]?.includes('R$ 2.500,00'), texts[1]);
check('página 2 tem o vencimento novo', texts[1]?.includes('dia 10'), texts[1]);
check('página 3 tem o texto acentuado', texts[2]?.includes('Olá, João — teste de acentuação: ção, ü, €'), texts[2]);
check('página 3 girada 90°', rotations[2] === 90, rotations);
check('páginas 1 e 2 sem rotação', rotations[0] === 0 && rotations[1] === 0, rotations);

const doc = await PDFDocument.load(bytes);
const form = doc.getForm();
check('campo nome preenchido', form.getTextField('nome').getText() === 'Adriano Hüttener', form.getTextField('nome').getText());
check('caixa aceito marcada', form.getCheckBox('aceito').isChecked());
check('cidade = Cork', form.getDropdown('cidade').getSelected()[0] === 'Cork', form.getDropdown('cidade').getSelected());

const original1000 = texts[1]?.includes('1.000,00');

console.log('--- Passos no app ---');
for (const s of report.steps) console.log(`${s.ok ? 'OK  ' : 'FALHA'} ${s.name}${s.ok ? '' : ' -> ' + JSON.stringify(s.info)}`);
console.log('--- Arquivo salvo ---');
for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FALHA'} ${c.name}${c.ok ? '' : ' -> ' + JSON.stringify(c.info)}`);
console.log(`(info) texto antigo "1.000,00" ainda existe por baixo da cobertura: ${original1000 ? 'sim' : 'não'}`);

const ok = report.ok && checks.every((c) => c.ok);
console.log(ok ? '\nTUDO OK' : '\nHÁ FALHAS');
process.exit(ok ? 0 : 1);
