// Autoteste ponta a ponta (só roda com --selftest): usa o app como um usuário,
// inclusive preenchendo os diálogos, e salva os resultados para o verificador (scripts/verify.mjs).
import { t, setLang } from './i18n.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (sel) => document.querySelector(sel);

async function until(cond, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = cond();
    if (v) return v;
    await wait(50);
  }
  throw new Error('tempo esgotado esperando condição');
}

// Responde ao próximo diálogo genérico preenchendo os campos indicados
async function answerDialog(values, submit = true) {
  await until(() => !$('#dialog').hidden);
  const form = $('#dialog-form');
  for (const [name, value] of Object.entries(values)) {
    const input = form.querySelector(`[name="${name}"]`);
    if (!input) throw new Error(`campo ${name} não existe no diálogo "${$('#dialog-title').textContent}"`);
    if (input.type === 'checkbox') input.checked = !!value; else input.value = value;
  }
  if (submit) form.requestSubmit();
  else form.querySelector('.btn:not(.primary)').click();
  await until(() => $('#dialog').hidden);
}

export async function runSelftest(ctx, cfg) {
  const { state, api, fabric, features } = ctx;
  state.selftest = true;
  setLang(cfg.lang || 'pt');
  const report = { ok: false, steps: [] };
  const step = (name, ok, info) => { report.steps.push({ name, ok: !!ok, info }); };

  try {
    // ---------- abrir e editar ----------
    await ctx.openFiles([cfg.main]);
    await wait(600);
    step('abre o PDF com 2 páginas', state.pages.length === 2, state.pages.length);
    step('lê 3 campos de formulário', state.formFields.length === 3);

    const [p1, p2] = state.pages;
    ctx.setTool('edittext');
    const runs = await ctx.ensureRuns(p1);
    const run = runs.find((r) => r.str.includes('1.000,00'));
    step('encontra a frase "Valor mensal"', !!run, runs.map((r) => r.str));
    const edited = ctx.onPickRun(p1, run);
    edited.exitEditing();
    edited.set('text', 'Valor mensal: R$ 2.500,00');
    edited.initDimensions();
    ctx.pushHistory(p1);
    const blue = ctx.onPickRun(p1, runs.find((r) => r.str.startsWith('Vencimento')));
    blue.exitEditing();
    step('detecta a cor azul do original', blue.fill !== '#000000', blue.fill);
    blue.set('text', 'Vencimento todo dia 10 de cada mês.');
    blue.initDimensions();
    ctx.pushHistory(p1);

    // desfazer / refazer
    const before = p1.fabric.getObjects().length;
    const tmp = ctx.addText(p1, new fabric.Point(300, 300), 'temporário');
    tmp.exitEditing();
    await ctx.undo();
    const afterUndo = p1.fabric.getObjects().length;
    await ctx.redo();
    const afterRedo = p1.fabric.getObjects().length;
    await ctx.undo();
    step('desfazer/refazer', afterUndo === before && afterRedo === before + 1, { before, afterUndo, afterRedo });

    // ---------- editar parágrafo (refluxo) ----------
    ctx.setTool('editpara');
    await ctx.ensureRuns(p2);
    const para = p2.paras.find((p) => p.str.includes('regido'));
    step('agrupa as 3 linhas do parágrafo', para && para.lineKeys.length === 3, para?.str);
    const paraText = ctx.onPickParagraph(p2, para);
    paraText.exitEditing();
    paraText.set('text', 'Este contrato segue a lei brasileira. Fica eleito o foro da comarca de Campinas, com renúncia a qualquer outro, por mais privilegiado que seja, para resolver quaisquer dúvidas sobre este instrumento.');
    paraText.initDimensions();
    ctx.pushHistory(p2);
    step('texto novo se reorganiza em várias linhas', paraText.textLines.length >= 3, paraText.textLines);
    ctx.setTool('select');

    // ---------- ferramentas de desenho e comentário ----------
    ctx.setTool('select');
    const novo = ctx.addText(p2, new fabric.Point(72, 330), 'Olá, João — teste de acentuação: ção, ü, €');
    novo.exitEditing();
    ctx.pushHistory(p2);
    const shape = (entry, tool, x0, y0, x1, y1) => ctx.addObjects(entry, [ctx.makeShape(tool, x0, y0, x1, y1)]);
    // "Cláusula 1: prazo de 12 meses." fica em y≈112 (topo da página na tela); cobrir apaga de verdade
    shape(p2, 'whiteout', 70, 100, 140, 116);
    shape(p2, 'highlight', 140, 100, 300, 116);
    shape(p2, 'rect', 60, 300, 420, 360);
    shape(p2, 'ellipse', 440, 300, 540, 360);
    shape(p2, 'line', 60, 400, 300, 400);
    shape(p2, 'arrow', 60, 430, 300, 470);
    shape(p2, 'underline', 70, 70, 260, 86);
    // tarjar o nome "Cidade:" da página 1 (y≈316)
    shape(p1, 'redact', 70, 304, 115, 320);
    ctx.addObjects(p1, [new fabric.Path('M 380 140 Q 430 90 480 140 T 560 140', { fill: '', stroke: '#d32f2f', strokeWidth: 3, kind: 'ink' })]);
    const sig = document.createElement('canvas');
    sig.width = 300; sig.height = 100;
    const g = sig.getContext('2d');
    g.strokeStyle = '#0d47a1'; g.lineWidth = 4; g.beginPath(); g.moveTo(10, 70); g.bezierCurveTo(80, 0, 120, 120, 290, 30); g.stroke();
    await ctx.addImage(p1, sig.toDataURL('image/png'), 'signature', 0.3, new fabric.Point(420, 680));
    await ctx.addImageFile(p2, cfg.image, 'image', 0.2, new fabric.Point(470, 620));
    features.addNote(p2, new fabric.Point(400, 180), 'Revisar esta cláusula com o advogado.');
    state.pendingStamp = 'APROVADO';
    await features.placeStamp(p2, new fabric.Point(420, 520));
    step('objetos das ferramentas', p2.fabric.getObjects().length >= 11 && p1.fabric.getObjects().length === 7,
      { p1: p1.fabric.getObjects().map((o) => o.kind), p2: p2.fabric.getObjects().map((o) => o.kind) });
    step('comentário aparece no painel', $('#comments').textContent.includes('Revisar esta cláusula'));

    // ---------- formulário e propriedades ----------
    const set = (name, value) => {
      const f = state.formFields.find((x) => x.name === name);
      f.value = value;
      for (const el of f.inputs) { if (f.type === 'checkbox') el.checked = value; else el.value = value; }
    };
    set('nome', 'Adriano Hüttener');
    set('aceito', true);
    set('cidade', 'Cork');
    let pending = features.run('properties');
    await answerDialog({ title: 'Contrato de teste', author: 'CyberSecInfo', subject: 'Autoteste', keywords: 'pdf, teste' });
    await pending;

    // ---------- páginas ----------
    const [anexo] = await ctx.insertDocs([cfg.extra]);
    ctx.movePage(anexo, 0);
    ctx.setCurrent(anexo);
    const blank = await ctx.insertBlankPage();
    ctx.addText(blank, new fabric.Point(72, 100), 'Página em branco inserida').exitEditing();
    let creating = features.createField(blank, { left: 72, top: 150, width: 200, height: 22 }, 'text');
    await answerDialog({ name: 'email' });
    await creating;
    creating = features.createField(blank, { left: 72, top: 190, width: 14, height: 14 }, 'check');
    await answerDialog({ name: 'concordo', required: true });
    await creating;
    creating = features.createField(blank, { left: 72, top: 220, width: 160, height: 22 }, 'list');
    await answerDialog({ name: 'plano', options: 'Básico\nPro\nEmpresa' });
    await creating;
    step('cria 3 campos de formulário', blank.fabric.getObjects().filter((o) => o.kind === 'field').length === 3);
    await ctx.duplicatePages([anexo]);
    step('páginas: inserir, mover, branco, duplicar', state.pages.length === 5 && state.pages[0] === anexo, state.pages.map((p) => `${p.docKey}:${p.index}`));
    const dup = state.pages[1];
    ctx.deletePages([dup]);
    ctx.rotatePage(p2, 1);
    step('excluir e girar', state.pages.length === 4 && p2.rotation() === 90);

    // ---------- marca d'água, cabeçalho/rodapé ----------
    pending = features.run('watermark');
    await answerDialog({ text: 'CONFIDENCIAL', size: 50, angle: -35, opacity: 15 });
    await pending;
    pending = features.run('pageNumbers');
    await answerDialog({ bc: 'Página {n} de {total}', tr: '{arquivo}' });
    await pending;
    const pageNums = state.pages.map((p) => p.fabric.getObjects().filter((o) => o.kind === 'hf').map((o) => o.text).join('|'));
    step("marca d'água e numeração", state.pages.every((p) => p.fabric.getObjects().some((o) => o.kind === 'watermark')) && pageNums[3].includes('Página 4 de 4'), pageNums);

    // ---------- busca ----------
    const hits = await features.runSearch('clausula');
    step('busca sem acento acha "Cláusula"', hits >= 2, hits);
    features.closeSearch();

    // ---------- senha ----------
    pending = features.run('password');
    await answerDialog({ user: 'segredo1', confirm: 'segredo1' });
    await pending;
    step('senha configurada', state.protection?.user === 'segredo1');

    ctx.setZoom(0.5);
    await wait(1200);
    await api.testScreenshot('1-editor.png');

    const saved = await ctx.save(false, 'saida.pdf');
    step('salva o PDF (com senha)', !!saved, saved);

    // ---------- conversões e exportações (sem senha) ----------
    step('PDF → Word', !!await features.run('toWord'));
    step('PDF → Texto', !!await features.run('toText'));
    const imgs = await features.toImages({ format: 'png', dpi: '96', which: 'all' });
    step('PDF → Imagens', imgs?.length === 4, imgs);
    state.selected = new Set([p1.id]);
    step('extrair página', !!await features.run('extractPages'));
    state.selected = new Set();
    const parts = await features.splitPdf({ mode: 'every', every: 2 });
    step('dividir a cada 2 páginas', parts?.length === 2, parts);
    pending = features.run('compress');
    await answerDialog({ level: 'high' });
    await pending;
    step('comprimir', !!state.lastCompress, state.lastCompress);

    // ---------- comparar com o contrato original ----------
    const comparing = features.compare(cfg.main);
    await until(() => !$('#dialog').hidden);
    const cmp = await comparing;
    await answerDialog({});
    step('comparação acha o que mudou', cmp && cmp.added.some((d) => d.text.includes('2.500,00')) && cmp.removed.some((d) => d.text.includes('1.000,00')),
      cmp && { added: cmp.added.slice(0, 5), removed: cmp.removed.slice(0, 5) });
    features.clearCompare();

    // ---------- reabrir o resultado (pede a senha) ----------
    state.dirty = false;
    const reopening = ctx.openFiles([{ name: 'saida.pdf', path: null, mime: 'application/pdf', data: state.lastSavedBytes }]);
    await answerDialog({ password: 'errada' });
    await until(() => !$('#dialog').hidden && $('#dialog-form').textContent.includes(t('Senha incorreta. Tente de novo.')));
    await answerDialog({ password: 'segredo1' });
    await reopening;
    await wait(500);
    step('reabre com a senha (recusa a errada)', state.pages.length === 4 && state.protection?.user === 'segredo1', state.pages.length);
    ctx.setZoom(0.7);
    for (let i = 0; i < state.pages.length; i++) {
      state.pages[i].el.scrollIntoView({ block: 'start' });
      await wait(700);
      await api.testScreenshot(`${2 + i}-saida-pagina-${i + 1}.png`);
    }

    // ---------- PDF protegido de fábrica ----------
    state.dirty = false;
    const opening = ctx.openFiles([cfg.locked]);
    await answerDialog({ password: 'abc' });
    await opening;
    step('abre PDF protegido de fora', state.pages.length === 2 && state.protection?.user === 'abc');

    // ---------- tarja em página duplicada (só a cópia) ----------
    state.dirty = false;
    await ctx.openFiles([cfg.main]);
    await ctx.duplicatePages([state.pages[0]]);
    const copy = state.pages[1];
    // "Valor mensal: R$ 1.000,00" fica em y≈122 (linha de base) na tela
    ctx.addObjects(copy, [ctx.makeShape('redact', 70, 108, 240, 126)]);
    step('tarja na cópia duplicada', !!await ctx.save(false, 'duplicada.pdf'));

    // ---------- documento grande: camada sob demanda, exclusão, marca d'água ----------
    state.dirty = false;
    await ctx.openFiles([cfg.big]);
    await wait(800);
    const mounted = state.pages.filter((p) => p.fabric).length;
    step('documento grande abre com camadas sob demanda', state.pages.length === 40 && mounted < 40, { paginas: state.pages.length, montadas: mounted });
    ctx.deletePages([state.pages[1]]);
    const far = state.pages[34];
    far.el.scrollIntoView({ block: 'start' });
    await wait(700);
    await ctx.materialize(far);
    ctx.addText(far, new fabric.Point(72, 200), 'Texto na página 36').exitEditing();
    ctx.pushHistory(far);
    state.pages[0].el.scrollIntoView({ block: 'start' });
    await wait(1200);
    step('página longe solta a camada e guarda a edição', far.fabric === null && far.lastJson.includes('Texto na página 36'), { montada: !!far.fabric });
    pending = features.run('watermark');
    await answerDialog({ text: 'GRANDE', size: 40, angle: -30, opacity: 20 });
    await pending;
    step("marca d'água em todas as 39 páginas", state.pages.every((p) => p.lastJson.includes('GRANDE') || p.fabric?.getObjects().some((o) => o.kind === 'watermark')));
    step('salva o documento grande', !!await ctx.save(false, 'grande.pdf'));

    // ---------- OCR ----------
    state.dirty = false;
    await ctx.openFiles([cfg.scan]);
    const before0 = (await ctx.ensureRuns(state.pages[0])).length;
    const ocr = await features.ocr({ which: 'all', force: false });
    const runsAfter = await ctx.ensureRuns(state.pages[0]);
    step('OCR em PDF escaneado', before0 === 0 && ocr?.total === 1 && runsAfter.some((r) => /ALUGUEL/i.test(r.str)), { before0, ocr, sample: runsAfter.slice(0, 3).map((r) => r.str) });
    const ocrSaved = await ctx.save(false, 'ocr.pdf');
    step('salva o PDF com OCR', !!ocrSaved);
    // PDF/A do escaneado (fontes já incorporadas pelo OCR: mantém as páginas)
    step('PDF/A do escaneado (direto)', !!await features.pdfa());

    // PDF/A do contrato (fontes não incorporadas: converte em imagem + OCR, com confirmação)
    state.dirty = false;
    await ctx.openFiles([cfg.main]);
    const converting = features.pdfa();
    await answerDialog({});
    step('PDF/A do contrato (imagem + OCR)', !!await converting);
    await api.testScreenshot('9-ocr.png');
  } catch (err) {
    step('erro inesperado', false, String(err?.stack || err));
  }

  report.ok = report.steps.every((s) => s.ok);
  await api.testReport(report);
}
