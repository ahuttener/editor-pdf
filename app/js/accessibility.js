// Acessibilidade por voz: ler o PDF em voz alta (no idioma do documento),
// ditar por voz nos campos e anúncios para leitor de tela.
// Tudo roda localmente no navegador/Electron, sem API paga e sem servidor.
import { t, getLang } from './i18n.js';

// ---------- detecção de idioma (sem dependências) ----------
// Conta palavras comuns de cada idioma para escolher a voz certa.
// Cobre os idiomas com voz instalada com mais frequência.
const LANG_HINTS = [
  ['pt', /\b(que|n[ãa]o|uma|com|para|como|mais|dos|das|voc[êe]|est[áa]|s[ãa]o|pela|isso|tamb[ée]m|ent[ãa]o|muito|quando)\b/gi],
  ['en', /\b(the|and|that|with|for|you|this|are|was|have|not|from|they|would|there|which|about|your)\b/gi],
  ['es', /\b(que|los|las|una|con|para|como|m[áa]s|del|pero|este|cuando|porque|tambi[ée]n|muy|est[áa]n)\b/gi],
  ['fr', /\b(les|des|une|avec|pour|que|pas|vous|est|sont|dans|cette|mais|comme|plus|nous|votre)\b/gi],
  ['de', /\b(der|die|und|den|das|mit|f[üu]r|nicht|ist|sind|auch|werden|einen|eine|aber|durch|oder)\b/gi],
  ['it', /\b(che|non|una|con|per|come|pi[ùu]|dei|delle|questo|quando|perch[ée]|anche|molto|sono)\b/gi],
];

function detectLang(text) {
  const sample = (text || '').slice(0, 5000);
  if (sample.replace(/\s/g, '').length < 20) return null;
  let best = null, bestScore = 0;
  for (const [code, re] of LANG_HINTS) {
    const n = (sample.match(re) || []).length;
    if (n > bestScore) { bestScore = n; best = code; }
  }
  return bestScore >= 3 ? best : null;
}

// ---------- vozes do sistema ----------
function ensureVoices() {
  const synth = window.speechSynthesis;
  return new Promise((resolve) => {
    let v = synth.getVoices();
    if (v.length) return resolve(v);
    const done = () => resolve(synth.getVoices());
    synth.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1200); // alguns ambientes não disparam o evento
  });
}

function pickVoice(voices, lang) {
  const l = (lang || '').toLowerCase();
  const prefer = l === 'pt' ? ['pt-br', 'pt-pt', 'pt'] : [l + '-', l];
  for (const p of prefer) {
    const hit = voices.find((v) => (v.lang || '').toLowerCase().startsWith(p));
    if (hit) return hit;
  }
  return voices.find((v) => (v.lang || '').toLowerCase().startsWith(l)) || null;
}

// Quebra o texto em pedaços curtos (frase a frase) para a leitura não cortar.
function chunkText(text, max = 240) {
  const parts = [];
  for (const para of text.split(/\n{2,}/)) {
    const clean = para.replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const sentences = clean.match(/[^.!?…]+[.!?…]*\s*/g) || [clean];
    let buf = '';
    for (const s of sentences) {
      if ((buf + s).length > max && buf) { parts.push(buf.trim()); buf = ''; }
      buf += s;
    }
    if (buf.trim()) parts.push(buf.trim());
  }
  return parts;
}

const LANG_NAME = { pt: 'Português', en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch', it: 'Italiano' };
const MAX_CHARS = 120000; // teto para documentos enormes

export function setupAccessibility(ctx) {
  const { toast } = ctx;
  const synth = window.speechSynthesis;
  const hasTTS = !!synth;
  const Recog = window.SpeechRecognition || window.webkitSpeechRecognition;

  injectStyles();
  const live = makeLiveRegion();
  const announce = (msg) => { live.textContent = ''; requestAnimationFrame(() => { live.textContent = msg; }); };

  // beep curto para quem não enxerga saber que o microfone ligou/desligou
  let audioCtx = null;
  function beep(freq = 660, ms = 120) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq; osc.type = 'sine';
      gain.gain.value = 0.08;
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(); osc.stop(audioCtx.currentTime + ms / 1000);
    } catch { /* som é só um reforço, pode falhar em silêncio */ }
  }

  // ---------- leitura em voz alta ----------
  const bar = makeReadingBar();
  let chunks = [], idx = 0, rate = 1, reading = false, curVoice = null, curLang = 'pt';

  async function readAloud() {
    if (!hasTTS) { toast(t('Este navegador não consegue ler em voz alta.'), true); return; }
    if (reading) { stopReading(); return; }
    if (!ctx.hasDoc()) { toast(t('Abra um PDF primeiro.')); return; }

    let pages;
    ctx.busy(t('Preparando a leitura…'));
    try {
      const bytes = await ctx.buildFinal({ encrypt: false });
      ({ pages } = await ctx.api.engine('structuredText', { bytes }));
    } catch (err) {
      ctx.busy(false);
      toast(t('Não deu certo: {erro}', { erro: String(err?.message || err) }), true);
      return;
    }
    ctx.busy(false);

    let text = (pages || []).map((p) => (p.text || '').trim()).filter(Boolean).join('\n\n').trim();
    if (text.replace(/\s/g, '').length < 10) {
      toast(t('Este PDF parece ser uma imagem escaneada, sem texto para ler. Use "OCR (reconhecer texto)" na aba Documento e tente de novo.'), true);
      announce(t('PDF sem texto para ler.'));
      return;
    }
    let truncated = false;
    if (text.length > MAX_CHARS) { text = text.slice(0, MAX_CHARS); truncated = true; }

    const voices = await ensureVoices();
    curLang = detectLang(text) || getLang() || 'pt';
    curVoice = pickVoice(voices, curLang);
    if (!curVoice) {
      toast(t('Não há voz instalada para o idioma detectado ({idioma}). Vou ler com a voz padrão.', { idioma: LANG_NAME[curLang] || curLang }), true);
    }

    chunks = chunkText(text);
    idx = 0; reading = true;
    bar.show(LANG_NAME[curLang] || curLang);
    announce(t('Lendo o documento em {idioma}.', { idioma: LANG_NAME[curLang] || curLang }) + (truncated ? ' ' + t('Documento muito longo: li apenas o começo.') : ''));
    speakNext();
  }

  function speakNext() {
    if (!reading || idx >= chunks.length) { if (reading) finishReading(); return; }
    const u = new SpeechSynthesisUtterance(chunks[idx]);
    if (curVoice) u.voice = curVoice;
    u.lang = curVoice?.lang || curLang;
    u.rate = rate;
    u.onend = () => { if (reading) { idx++; bar.progress(idx, chunks.length); speakNext(); } };
    u.onerror = () => { if (reading) { idx++; speakNext(); } };
    try { synth.speak(u); } catch { finishReading(); }
  }

  function finishReading() {
    reading = false; try { synth.cancel(); } catch {}
    bar.hide(); announce(t('Leitura concluída.'));
  }
  function stopReading() {
    if (!reading) return;
    reading = false; try { synth.cancel(); } catch {}
    bar.hide(); announce(t('Leitura interrompida.'));
  }
  function pauseReading() {
    if (!reading) return;
    if (synth.paused) { synth.resume(); bar.setPaused(false); announce(t('Continuando a leitura.')); }
    else { synth.pause(); bar.setPaused(true); announce(t('Leitura pausada.')); }
  }
  function setRate(r) {
    rate = r;
    // a nova velocidade vale a partir da próxima frase
    if (reading && !synth.paused) { try { synth.cancel(); } catch {} speakNext(); }
  }

  // ---------- ditado por voz ----------
  let recog = null, dictating = false, dictationTarget = null;

  function dictate() {
    if (dictating) { stopDictation(); return; }
    if (!Recog) {
      toast(t('O ditado por voz não está disponível neste aplicativo. Use o microfone do teclado, ou a versão no navegador Chrome.'), true);
      return;
    }
    if (!ctx.hasDoc()) { toast(t('Abra um PDF primeiro.')); return; }

    recog = new Recog();
    recog.lang = bcp47(getLang());
    recog.continuous = true;
    recog.interimResults = false;
    recog.onresult = (e) => {
      let said = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) said += e.results[i][0].transcript;
      }
      said = said.trim();
      if (said) insertDictated(said + ' ');
    };
    recog.onerror = (e) => {
      const msg = e.error === 'not-allowed' || e.error === 'service-not-allowed'
        ? t('Permissão de microfone negada ou indisponível neste aplicativo.')
        : e.error === 'no-speech' ? t('Não ouvi nada. Tente de novo.')
        : t('O ditado falhou ({erro}).', { erro: e.error });
      toast(msg, true); stopDictation();
    };
    recog.onend = () => { if (dictating) { try { recog.start(); } catch { stopDictation(); } } };

    try {
      recog.start();
      dictating = true; dictationTarget = null;
      beep(760); announce(t('Ditado ligado. Fale e o texto será escrito.'));
      toast(t('Ditado ligado. Clique de novo em "Ditar" para parar.'));
    } catch {
      toast(t('Não consegui iniciar o ditado por voz.'), true);
    }
  }

  function stopDictation() {
    dictating = false;
    try { recog && recog.stop(); } catch {}
    recog = null; beep(440); announce(t('Ditado desligado.'));
  }

  function insertDictated(txt) {
    const entry = ctx.state.current;
    const canvas = entry?.fabric;
    if (!canvas) return;
    let obj = canvas.getActiveObject();
    const isText = obj && (obj.type === 'i-text' || obj.type === 'text' || obj.type === 'textbox');

    if (isText && obj.isEditing) {
      const start = obj.selectionStart ?? obj.text.length;
      obj.insertChars(txt, null, start, obj.selectionEnd ?? start);
      obj.selectionStart = obj.selectionEnd = start + txt.length;
      if (obj.hiddenTextarea) obj.hiddenTextarea.value = obj.text;
      canvas.requestRenderAll();
    } else if (dictationTarget && dictationTarget.canvas === canvas) {
      const o = dictationTarget.obj;
      o.text += txt; o.set('text', o.text);
      canvas.requestRenderAll();
    } else {
      // cria uma caixa de texto nova e passa a ditar nela
      ctx.addText(entry, { x: 72, y: 72 }, txt.trim());
      dictationTarget = { canvas, obj: canvas.getActiveObject() };
    }
    ctx.setDirty && ctx.setDirty(true);
  }

  // ---------- atalhos de teclado ----------
  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'l') { e.preventDefault(); readAloud(); }
      else if (k === 'd') { e.preventDefault(); dictate(); }
      else if (k === 'p' && reading) { e.preventDefault(); pauseReading(); }
    }
    if (e.key === 'Escape') { if (reading) stopReading(); if (dictating) stopDictation(); }
  });

  // ---------- barra de leitura (DOM) ----------
  function makeReadingBar() {
    const el = document.createElement('div');
    el.className = 'a11y-bar';
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', t('Controles de leitura em voz alta'));
    el.hidden = true;
    el.innerHTML = `
      <span class="a11y-icon" aria-hidden="true">🔊</span>
      <span class="a11y-label"></span>
      <button type="button" class="a11y-btn" data-act="pause">${t('Pausar')}</button>
      <button type="button" class="a11y-btn" data-act="stop">${t('Parar')}</button>
      <label class="a11y-rate">${t('Velocidade')}
        <select aria-label="${t('Velocidade')}">
          <option value="0.75">0,75×</option>
          <option value="1" selected>1×</option>
          <option value="1.25">1,25×</option>
          <option value="1.5">1,5×</option>
        </select>
      </label>
      <span class="a11y-progress" aria-hidden="true"></span>`;
    document.body.appendChild(el);
    const label = el.querySelector('.a11y-label');
    const pauseBtn = el.querySelector('[data-act="pause"]');
    const prog = el.querySelector('.a11y-progress');
    el.querySelector('[data-act="pause"]').addEventListener('click', pauseReading);
    el.querySelector('[data-act="stop"]').addEventListener('click', stopReading);
    el.querySelector('select').addEventListener('change', (ev) => setRate(parseFloat(ev.target.value)));
    return {
      show(langName) { label.textContent = t('Lendo em {idioma}', { idioma: langName }); pauseBtn.textContent = t('Pausar'); prog.textContent = ''; el.hidden = false; },
      hide() { el.hidden = true; },
      setPaused(p) { pauseBtn.textContent = p ? t('Continuar') : t('Pausar'); },
      progress(i, total) { prog.textContent = `${i}/${total}`; },
    };
  }

  return { readAloud, dictate, stopReading, stopDictation };
}

// ---------- helpers de DOM ----------
function bcp47(lang) {
  return ({ pt: 'pt-BR', en: 'en-US' })[lang] || lang || 'pt-BR';
}

function makeLiveRegion() {
  let el = document.getElementById('a11y-live');
  if (!el) {
    el = document.createElement('div');
    el.id = 'a11y-live';
    el.className = 'sr-only';
    el.setAttribute('aria-live', 'assertive');
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  return el;
}

function injectStyles() {
  if (document.getElementById('a11y-styles')) return;
  const s = document.createElement('style');
  s.id = 'a11y-styles';
  s.textContent = `
    .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
    .a11y-bar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:9999;
      display:flex;align-items:center;gap:10px;padding:8px 14px;border-radius:10px;
      background:#102a43;color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.35);font-size:14px}
    .a11y-bar .a11y-icon{font-size:18px}
    .a11y-bar .a11y-label{font-weight:600}
    .a11y-bar .a11y-btn{background:#1f5eff;color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:14px}
    .a11y-bar .a11y-btn:hover{filter:brightness(1.1)}
    .a11y-bar .a11y-rate{display:flex;align-items:center;gap:6px}
    .a11y-bar select{border-radius:6px;padding:4px}
    .a11y-bar .a11y-progress{opacity:.8;min-width:48px;text-align:right}
    @media (prefers-color-scheme: light){ .a11y-bar{background:#13395f} }
  `;
  document.head.appendChild(s);
}
