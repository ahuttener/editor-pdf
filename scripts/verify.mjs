// Confere os arquivos gerados pelo autoteste: PDF salvo (com senha), exportações, OCR.
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { ops } from '../engine/ops.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const dir = path.resolve(process.argv[2] || 'test-output');
const report = JSON.parse(await fs.readFile(path.join(dir, 'report.json'), 'utf8'));
const checks = [];
const check = (name, ok, info) => checks.push({ name, ok: !!ok, info });
const exists = async (p) => fs.access(p).then(() => true, () => false);

async function pageTexts(bytes) {
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    out.push({ text: tc.items.map((it) => it.str).join(' '), rotate: page.rotate, annots: (await page.getAnnotations()).map((a) => a.subtype) });
  }
  return out;
}

// --- PDF principal (com senha) ---
const raw = new Uint8Array(await fs.readFile(path.join(dir, 'saida.pdf')));
const info = ops.inspect({ bytes: raw });
check('saída protegida por senha', info.encrypted && info.needsPassword, info);
check('senha errada é recusada', ops.unlock({ bytes: raw, password: 'errada' }).ok === false);
const unlocked = ops.unlock({ bytes: raw, password: 'segredo1' });
check('senha certa abre', unlocked.ok);
const bytes = unlocked.bytes;
const pages = await pageTexts(bytes);
check('4 páginas', pages.length === 4, pages.length);
check('página 1 é o anexo', pages[0]?.text.includes('ANEXO I'), pages[0]?.text);
check('página 2: página em branco com texto', pages[1]?.text.includes('Página em branco inserida'), pages[1]?.text);
check('página 3: valor novo', pages[2]?.text.includes('R$ 2.500,00'), pages[2]?.text);
check('página 3: valor antigo APAGADO de verdade', !pages[2]?.text.includes('1.000,00'), pages[2]?.text);
check('página 3: vencimento novo', pages[2]?.text.includes('dia 10'), pages[2]?.text);
check('página 3: "Cidade:" tarjado (removido)', !/Cidade:/.test(pages[2]?.text), pages[2]?.text);
check('página 4: texto acentuado', pages[3]?.text.includes('Olá, João — teste de acentuação: ção, ü, €'), pages[3]?.text);
check('página 4: "Cláusula 1" coberto e apagado', !/Cláusula 1/.test(pages[3]?.text), pages[3]?.text);
check('página 4 girada 90°', pages[3]?.rotate === 90, pages.map((p) => p.rotate));
check('página 4: nota virou comentário do PDF', pages[3]?.annots.includes('Text'), pages[3]?.annots);
check("marca d'água em todas", pages.every((p) => p.text.includes('CONFIDENCIAL')));
check('numeração de páginas', pages.every((p, i) => p.text.includes(`Página ${i + 1} de 4`)), pages.map((p) => p.text.match(/Página \d de \d/)?.[0]));

const doc = await PDFDocument.load(bytes);
const form = doc.getForm();
check('campo nome', form.getTextField('nome').getText() === 'Adriano Hüttener');
check('caixa aceito', form.getCheckBox('aceito').isChecked());
check('cidade = Cork', form.getDropdown('cidade').getSelected()[0] === 'Cork');
{
  const names = form.getFields().map((f) => f.getName());
  const plano = names.includes('plano') ? form.getDropdown('plano').getOptions() : [];
  check('campos criados (email, concordo, plano)', names.includes('email') && names.includes('concordo') && plano.join('|') === 'Básico|Pro|Empresa', { names, plano });
  check('campo obrigatório marcado', names.includes('concordo') && form.getCheckBox('concordo').isRequired());
}
check('parágrafo editado com o texto novo', pages[3]?.text.includes('Campinas') && !pages[3]?.text.includes('São Paulo'), pages[3]?.text);
check('propriedades (título/autor)', doc.getTitle() === 'Contrato de teste' && doc.getAuthor() === 'CyberSecInfo', { t: doc.getTitle(), a: doc.getAuthor() });

// --- exportações ---
const docx = await fs.readFile(path.join(dir, 'convertido.docx'));
check('Word gerado (.docx válido)', docx.subarray(0, 2).toString() === 'PK' && docx.length > 3000, docx.length);
const txt = await fs.readFile(path.join(dir, 'texto.txt'), 'utf8');
check('texto exportado', txt.includes('R$ 2.500,00') && txt.includes('ANEXO I'));
const exported = await fs.readdir(path.join(dir, 'export'));
check('4 imagens + 2 partes divididas', exported.filter((f) => f.endsWith('.png')).length === 4 && exported.filter((f) => /(parte|part) \d/.test(f)).length === 2, exported);
const extracted = await PDFDocument.load(await fs.readFile(path.join(dir, 'extraidas.pdf')));
check('página extraída', extracted.getPageCount() === 1);
const comp = new Uint8Array(await fs.readFile(path.join(dir, 'comprimido.pdf')));
check('comprimido também com senha', ops.inspect({ bytes: comp }).needsPassword);

// --- tarja só na página duplicada ---
const dup = await pageTexts(new Uint8Array(await fs.readFile(path.join(dir, 'duplicada.pdf'))));
check('duplicada: original mantém o valor', dup[0]?.text.includes('1.000,00'), dup[0]?.text);
check('duplicada: cópia tarjada perdeu o valor de verdade', dup.length === 3 && !dup[1]?.text.includes('1.000,00'), dup[1]?.text);

// --- documento grande ---
const bigBytes = new Uint8Array(await fs.readFile(path.join(dir, 'grande.pdf')));
const big = await pageTexts(bigBytes);
check('grande: 39 páginas (uma excluída)', big.length === 39, big.length);
check("grande: marca d'água em todas", big.every((p) => p.text.includes('GRANDE')));
check('grande: texto na página 36 (editada longe da tela)', big[34]?.text.includes('Texto na página 36'), big[34]?.text);
{
  const mupdf = await import('mupdf');
  const d = mupdf.Document.openDocument(bigBytes, 'application/pdf').asPDF();
  let leaked = false;
  for (let n = 1; n < d.countObjects(); n++) {
    const o = d.newIndirect(n, 0);
    if (o.isStream() && o.readStream().asString().includes('SEGREDO')) leaked = true;
  }
  check('grande: página excluída sumiu DE DENTRO do arquivo', !leaked && !Buffer.from(bigBytes).includes('SEGREDO'));
}

// --- PDF/A validado pelo veraPDF (se estiver instalado) ---
{
  const vera = path.join(process.env.USERPROFILE || process.env.HOME || '', 'Tools', 'verapdf', process.platform === 'win32' ? 'verapdf.bat' : 'verapdf');
  for (const name of ['pdfa-1.pdf', 'pdfa-2.pdf']) {
    const file = path.join(dir, name);
    if (!await exists(file)) { check(`${name} gerado`, false); continue; }
    if (!await exists(vera)) { console.log(`(info) veraPDF não instalado; ${name} não validado`); continue; }
    const { execFileSync } = await import('node:child_process');
    const javaHome = 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.12.101-hotspot';
    let outText = '';
    try { outText = execFileSync('cmd.exe', ['/c', vera, '--flavour', '2b', '--format', 'text', file], { env: { ...process.env, JAVA_HOME: javaHome, PATH: `${javaHome}\\bin;${process.env.PATH}` }, encoding: 'utf8' }); }
    catch (e) { outText = String(e.stdout || e.message); }
    check(`${name}: veraPDF aprova PDF/A-2b`, /^PASS/m.test(outText), outText.trim().slice(0, 200));
  }
}

// --- OCR ---
const ocr = await pageTexts(new Uint8Array(await fs.readFile(path.join(dir, 'ocr.pdf'))));
check('PDF escaneado ficou pesquisável', /CONTRATO\s+DE\s+ALUGUEL/.test(ocr[0]?.text), ocr[0]?.text.slice(0, 80));

console.log('--- Passos no app ---');
for (const s of report.steps) console.log(`${s.ok ? 'OK   ' : 'FALHA'} ${s.name}${s.ok ? '' : ' -> ' + String(JSON.stringify(s.info)).slice(0, 600)}`);
console.log('--- Arquivos gerados ---');
for (const c of checks) console.log(`${c.ok ? 'OK   ' : 'FALHA'} ${c.name}${c.ok ? '' : ' -> ' + String(JSON.stringify(c.info)).slice(0, 400)}`);
const ok = report.ok && checks.every((c) => c.ok);
console.log(ok ? '\nTUDO OK' : '\nHÁ FALHAS');
process.exit(ok ? 0 : 1);
