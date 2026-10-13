// Gera os PDFs de teste em test-fixtures/ (contrato com formulário + anexo)
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fs from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve('test-fixtures');
await fs.mkdir(dir, { recursive: true });

const doc = await PDFDocument.create();
const helv = await doc.embedFont(StandardFonts.Helvetica);
const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
const times = await doc.embedFont(StandardFonts.TimesRoman);

const p1 = doc.addPage([595, 842]);
p1.drawText('CONTRATO DE ALUGUEL', { x: 72, y: 760, size: 20, font: helvBold });
p1.drawText('Valor mensal: R$ 1.000,00', { x: 72, y: 720, size: 12, font: helv });
p1.drawText('Vencimento todo dia 5 de cada mês.', { x: 72, y: 700, size: 12, font: helv, color: rgb(0.1, 0.2, 0.6) });
p1.drawText('Nome do locatário:', { x: 72, y: 606, size: 12, font: helv });
p1.drawText('Aceito os termos', { x: 96, y: 566, size: 12, font: helv });
p1.drawText('Cidade:', { x: 72, y: 526, size: 12, font: helv });

const form = doc.getForm();
const nome = form.createTextField('nome');
nome.addToPage(p1, { x: 190, y: 600, width: 250, height: 20, font: helv });
const aceito = form.createCheckBox('aceito');
aceito.addToPage(p1, { x: 72, y: 562, width: 16, height: 16 });
const cidade = form.createDropdown('cidade');
cidade.addOptions(['Dublin', 'Cork', 'Galway']);
cidade.addToPage(p1, { x: 190, y: 520, width: 150, height: 20, font: helv });

const p2 = doc.addPage([595, 842]);
p2.drawText('Página dois - cláusulas', { x: 72, y: 760, size: 16, font: times });
p2.drawText('Cláusula 1: prazo de 12 meses.', { x: 72, y: 730, size: 12, font: times });

await fs.writeFile(path.join(dir, 'contrato.pdf'), await doc.save());

const anexo = await PDFDocument.create();
const a1 = anexo.addPage([595, 842]);
a1.drawText('ANEXO I', { x: 72, y: 760, size: 24, font: await anexo.embedFont(StandardFonts.HelveticaBold) });
a1.drawText('Inventário do imóvel.', { x: 72, y: 725, size: 12, font: await anexo.embedFont(StandardFonts.Helvetica) });
await fs.writeFile(path.join(dir, 'anexo.pdf'), await anexo.save());

console.log('Fixtures em', dir);
