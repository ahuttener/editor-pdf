// Autoteste ponta a ponta (só roda com --selftest): edita, organiza, preenche e salva,
// depois reabre o arquivo salvo e tira capturas de tela para conferência.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runSelftest(ctx, cfg) {
  const { state, api, fabric } = ctx;
  const report = { ok: false, steps: [] };
  const step = (name, ok, info) => { report.steps.push({ name, ok: !!ok, info }); };

  try {
    await ctx.openFile(cfg.main);
    await wait(800);
    step('abre o PDF com 2 páginas', state.pages.length === 2, state.pages.length);
    step('lê 3 campos de formulário', state.formFields.length === 3, state.formFields.map((f) => `${f.name}:${f.type}`));

    const [p1, p2] = state.pages;

    // Editar texto existente
    ctx.setTool('edittext');
    const runs = await ctx.ensureRuns(p1);
    const run = runs.find((r) => r.str.includes('1.000,00'));
    step('encontra a frase "Valor mensal"', !!run, runs.map((r) => r.str));
    const hits = p1.hitLayer.querySelectorAll('.text-hit').length;
    step('mostra áreas clicáveis', hits >= 5, hits);
    const edited = ctx.onPickRun(p1, run);
    edited.exitEditing();
    edited.set('text', 'Valor mensal: R$ 2.500,00');
    edited.initDimensions();
    p1.fabric.requestRenderAll();
    ctx.pushHistory(p1);
    step('edição cria cobertura + texto', p1.fabric.getObjects().filter((o) => o.runKey === run.key).length === 2);

    const blue = runs.find((r) => r.str.startsWith('Vencimento'));
    const blueEdit = ctx.onPickRun(p1, blue);
    blueEdit.exitEditing();
    step('detecta cor azul do texto original', /^#1[0-9a-f]3[0-9a-f]9[0-9a-f]$/i.test(blueEdit.fill) || blueEdit.fill !== '#000000', blueEdit.fill);
    blueEdit.set('text', 'Vencimento todo dia 10 de cada mês.');
    blueEdit.initDimensions();
    ctx.pushHistory(p1);

    // Desfazer / refazer
    const before = p1.fabric.getObjects().length;
    const tmp = ctx.addText(p1, new fabric.Point(300, 300), 'temporário');
    tmp.exitEditing();
    ctx.pushHistory(p1);
    await ctx.undo();
    const afterUndo = state.pages[0].fabric.getObjects().length;
    await ctx.redo();
    const afterRedo = state.pages[0].fabric.getObjects().length;
    await ctx.undo();
    step('desfazer/refazer', afterUndo === before && afterRedo === before + 1, { before, afterUndo, afterRedo });

    // Texto novo, cobrir, destacar, retângulo, desenho, imagem
    ctx.setTool('select');
    const novo = ctx.addText(p2, new fabric.Point(72, 300), 'Olá, João — teste de acentuação: ção, ü, €');
    novo.exitEditing();
    ctx.pushHistory(p2);
    const add = (entry, obj) => { entry.fabric.add(obj); ctx.pushHistory(entry); };
    add(p2, ctx.makeShape('whiteout', 70, 105, 60, 22));
    add(p2, ctx.makeShape('highlight', 70, 100, 230, 18));
    add(p2, ctx.makeShape('rect', 60, 270, 360, 50));
    add(p1, new fabric.Path('M 380 140 Q 430 90 480 140 T 560 140', { fill: '', stroke: '#d32f2f', strokeWidth: 3, kind: 'ink' }));
    const sig = document.createElement('canvas');
    sig.width = 300; sig.height = 100;
    const g = sig.getContext('2d');
    g.strokeStyle = '#0d47a1'; g.lineWidth = 4; g.beginPath(); g.moveTo(10, 70); g.bezierCurveTo(80, 0, 120, 120, 290, 30); g.stroke();
    const img = await ctx.addImage(p1, sig.toDataURL('image/png'), 'signature', 0.3);
    img.set({ left: 300, top: 640 });
    img.setCoords();
    ctx.pushHistory(p1);
    step('objetos adicionados', p2.fabric.getObjects().length === 4 && p1.fabric.getObjects().length === 6, { p1: p1.fabric.getObjects().length, p2: p2.fabric.getObjects().length });

    // Formulário
    const set = (name, value) => {
      const f = state.formFields.find((x) => x.name === name);
      f.value = value;
      for (const el of f.inputs) { if (f.type === 'checkbox') el.checked = value; else el.value = value; }
    };
    set('nome', 'Adriano Hüttener');
    set('aceito', true);
    set('cidade', 'Cork');

    // Páginas: inserir anexo, mover para o início, girar a página 2
    const added = await ctx.insertDocs([cfg.extra]);
    step('insere o anexo', added.length === 1 && state.pages.length === 3);
    ctx.movePage(added[0], 0);
    step('move o anexo para o início', state.pages[0] === added[0]);
    ctx.rotatePage(p2, 1);
    step('gira a página de cláusulas', p2.rotation() === 90);

    ctx.setZoom(0.6);
    await wait(1200);
    await api.testScreenshot('1-editor.png');

    const saved = await ctx.save(false, 'saida.pdf');
    step('salva o PDF', !!saved, saved);

    // Reabre o resultado para conferir visualmente
    state.dirty = false;
    await ctx.openFile({ name: 'saida.pdf', path: null, data: state.lastSavedBytes });
    ctx.setZoom(0.75);
    await wait(500);
    for (let i = 0; i < state.pages.length; i++) {
      state.pages[i].el.scrollIntoView({ block: 'start' });
      await wait(900);
      await api.testScreenshot(`${2 + i}-saida-pagina-${i + 1}.png`);
    }
    step('reabre o PDF salvo com 3 páginas', state.pages.length === 3, state.pages.length);
  } catch (err) {
    step('erro inesperado', false, String(err?.stack || err));
  }

  report.ok = report.steps.every((s) => s.ok);
  await api.testReport(report);
}
