// Voz no app: ler o PDF em voz alta, no idioma do próprio documento.
// Usa a voz do celular (TTS nativo / speechSynthesis) — roda localmente, sem custo e sem servidor.
import { Capacitor } from '@capacitor/core';
import { TextToSpeech } from '@capacitor-community/text-to-speech';
import { t, getLang } from './i18n.js';
import { $, esc, sheet, toast, busy } from './ui.js';
import { engine } from './engine.js';
import { icon } from './icons.js';

// ---------- detecção de idioma (sem dependências) ----------
// Conta palavras comuns de cada idioma para escolher a voz certa.
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
    const v = synth.getVoices();
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
const bcp47 = (lang) => ({ pt: 'pt-BR', en: 'en-US' })[lang] || lang || 'pt-BR';

// bcp47 completo para o TTS nativo (precisa do país).
const bcp47Full = (lang) => ({ pt: 'pt-BR', en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', it: 'it-IT' })[lang] || lang || 'pt-BR';

// No celular (Capacitor) usamos o TTS nativo; no navegador, o speechSynthesis.
const isNative = () => { try { return Capacitor.isNativePlatform(); } catch { return false; } };

export function ttsSupported() {
  // No celular usamos o TTS nativo (plugin); no navegador, o speechSynthesis.
  return isNative() || (typeof window !== 'undefined' && 'speechSynthesis' in window);
}

// Lê em voz alta os bytes de um PDF (o documento aberto no editor).
export async function readAloudPdf(bytes) {
  const native = isNative();
  const synth = (typeof window !== 'undefined') ? window.speechSynthesis : null;
  if (!native && !synth) { toast(t('Este aparelho não consegue ler em voz alta.'), 'error'); return; }

  // Navegador/iOS: "desbloqueia" o TTS ainda dentro do toque. No celular (plugin nativo) não precisa.
  if (!native && synth) { try { synth.cancel(); const warm = new SpeechSynthesisUtterance(''); warm.volume = 0; synth.speak(warm); } catch { /* ok */ } }

  let pages;
  const stop = busy(t('Preparando a leitura…'));
  try {
    ({ pages } = await engine('structuredText', { bytes: bytes.slice() }));
  } catch (err) {
    stop(); console.error(err);
    toast(t('Não foi possível ler o texto deste PDF.'), 'error');
    return;
  }
  stop();

  let text = (pages || []).map((p) => (p.text || '').trim()).filter(Boolean).join('\n\n').trim();
  if (text.replace(/\s/g, '').length < 10) {
    toast(t('Este PDF parece ser uma imagem escaneada, sem texto para ler. Use o OCR na aba Ferramentas e tente de novo.'), 'error');
    return;
  }
  let truncated = false;
  if (text.length > MAX_CHARS) { text = text.slice(0, MAX_CHARS); truncated = true; }

  const lang = detectLang(text) || getLang() || 'pt';
  const chunks = chunkText(text);

  // Celular: TTS nativo (Android/iOS). Navegador: Web Speech API.
  let driver;
  if (native) {
    driver = nativeDriver(bcp47Full(lang));
  } else {
    const voices = await ensureVoices();
    const voice = pickVoice(voices, lang);
    if (!voice) toast(t('Não há voz instalada para {idioma}; vou ler com a voz padrão.', { idioma: LANG_NAME[lang] || lang }));
    driver = webDriver(synth, voice, lang);
  }
  openListenSheet({ driver, chunks, lang, truncated, key: textKey(text) });
}

// ---------- onde a leitura parou (por documento) ----------
// A chave é um resumo do próprio texto: o mesmo PDF continua de onde parou,
// venha da tela inicial, da biblioteca ou do editor.
const POS_KEY = 'editorpdf.listen.v1';
function textKey(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${h.toString(36)}-${text.length}`;
}
function readPositions() { try { return JSON.parse(localStorage.getItem(POS_KEY) || '{}') || {}; } catch { return {}; } }
function savedPosition(key, total) {
  const p = readPositions()[key];
  return (p && p.n === total && p.i > 0 && p.i < total) ? p.i : 0;
}
function savePosition(key, i, total) {
  try {
    const all = readPositions();
    if (i <= 0 || i >= total) delete all[key];
    else all[key] = { i, n: total, at: Date.now() };
    // guarda só os 30 mais recentes
    const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 30);
    localStorage.setItem(POS_KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch { /* sem espaço: segue sem lembrar */ }
}

// ---------- "motores" de voz: falam uma frase e avisam quando terminou ----------
function nativeDriver(loc) {
  return {
    speak: (text, rate) => TextToSpeech.speak({ text, lang: loc, rate }),
    stop: () => TextToSpeech.stop().catch(() => { /* ok */ }),
  };
}

function webDriver(synth, voice, lang) {
  return {
    speak: (text, rate) => new Promise((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(text);
      if (voice) u.voice = voice;
      u.lang = voice?.lang || bcp47(lang);
      u.rate = rate;
      u.onend = () => resolve();
      u.onerror = (e) => reject(e);
      try { synth.speak(u); } catch (err) { reject(err); }
    }),
    stop: () => { try { synth.cancel(); } catch { /* ok */ } },
  };
}

// ---------- Modo Ouvir: frase atual em destaque, voltar/avançar, continuar de onde parou ----------
// "Pausar" interrompe e guarda a frase (o TTS nativo não tem pausa real); "Continuar" refala a frase.
function openListenSheet({ driver, chunks, lang, truncated, key }) {
  const name = LANG_NAME[lang] || lang;
  const total = chunks.length;
  const resumeAt = savedPosition(key, total);
  let idx = resumeAt, rate = 1, finished = false, paused = false, gen = 0;

  const content = `
    <p class="sheet-text"><span data-status role="status" aria-live="polite"></span></p>
    ${truncated ? `<p class="form-note">${esc(t('Documento muito longo: vou ler apenas o começo.'))}</p>` : ''}
    ${resumeAt ? `<p class="form-note listen-resume">${esc(t('Continuando de onde você parou.'))} <button class="link" data-restart>${esc(t('Recomeçar do início'))}</button></p>` : ''}
    <div class="listen-now" lang="${esc(bcp47Full(lang))}" aria-hidden="true"><p data-now></p></div>
    <div class="listen-progress" aria-hidden="true"><div class="listen-bar"><span data-bar></span></div><small data-count></small></div>
    <div class="listen-controls">
      <button class="icon-btn listen-skip" data-prev aria-label="${esc(t('Frase anterior'))}">${icon('chevronLeft', { size: 26 })}</button>
      <button class="btn btn-primary listen-main" data-pause>${esc(t('Pausar'))}</button>
      <button class="icon-btn listen-skip" data-next aria-label="${esc(t('Próxima frase'))}">${icon('chevronRight', { size: 26 })}</button>
    </div>
    <div class="listen-row">
      <label class="field listen-field"><span>${esc(t('Velocidade'))}</span>
        <select data-rate>
          <option value="0.75">0,75×</option>
          <option value="1" selected>1×</option>
          <option value="1.25">1,25×</option>
          <option value="1.5">1,5×</option>
        </select>
      </label>
      <div class="listen-size" role="group" aria-label="${esc(t('Tamanho do texto'))}">
        <button class="icon-btn" data-size="-1" aria-label="${esc(t('Diminuir texto'))}">A−</button>
        <button class="icon-btn" data-size="1" aria-label="${esc(t('Aumentar texto'))}">A+</button>
      </div>
    </div>
    <div class="sheet-actions"><button class="btn btn-secondary" data-stop>${esc(t('Parar'))}</button></div>`;

  const s = sheet(content, {
    title: t('Ouvindo o PDF'),
    onClose: () => { gen++; driver.stop(); if (!finished) savePosition(key, idx, total); },
  });

  const statusEl = $('[data-status]', s.el);
  const pauseBtn = $('[data-pause]', s.el);
  const nowEl = $('[data-now]', s.el);
  const nowBox = $('.listen-now', s.el);
  const barEl = $('[data-bar]', s.el);
  const countEl = $('[data-count]', s.el);
  let size = 0;
  try { size = parseInt(localStorage.getItem('editorpdf.listen.size') || '0', 10) || 0; } catch { /* ok */ }
  const applySize = () => { nowBox.style.fontSize = `${20 + size * 3}px`; };
  applySize();

  // A região "ao vivo" só muda em início/pausa/fim (o leitor de tela não fala por cima da leitura);
  // a frase em destaque e a barra são visuais.
  const render = () => {
    const msg = finished ? t('Leitura concluída.') : paused ? t('Pausado') : t('Lendo em {idioma}', { idioma: name });
    if (statusEl.textContent !== msg) statusEl.textContent = msg;
    const i = Math.min(idx, total - 1);
    nowEl.textContent = chunks[i] || '';
    barEl.style.width = `${Math.round(((finished ? total : idx) / total) * 100)}%`;
    countEl.textContent = finished ? '' : `${i + 1}/${total}`;
    pauseBtn.textContent = finished ? t('Ouvir de novo') : paused ? t('Continuar') : t('Pausar');
    $('[data-prev]', s.el).disabled = idx <= 0;
    $('[data-next]', s.el).disabled = finished || idx >= total - 1;
  };

  async function play() {
    const my = ++gen;
    let failedFirst = true;
    while (my === gen && idx < total) {
      render();
      try {
        await driver.speak(chunks[idx], rate);
        failedFirst = false;
      } catch (err) {
        if (my !== gen) return;        // parar/pausar/pular cancelam a fala e caem aqui
        if (failedFirst && idx === resumeAt) { // falhou já na 1ª frase: idioma/voz indisponível
          console.error(err);
          toast(t('Não há voz instalada para {idioma}; instale a voz nas configurações do aparelho.', { idioma: name }), 'error');
          gen++; s.close(); return;
        }
        // uma frase solta falhou: pula para a próxima
      }
      if (my !== gen) return;
      idx++;
      savePosition(key, idx, total);
    }
    if (my === gen && idx >= total) { finished = true; savePosition(key, total, total); render(); }
  }
  const halt = () => { gen++; driver.stop(); };
  const jump = (to) => {
    halt();
    idx = Math.max(0, Math.min(total - 1, to));
    finished = false;
    savePosition(key, idx, total);
    if (paused) render(); else play();
  };

  pauseBtn.addEventListener('click', () => {
    if (finished) { finished = false; paused = false; idx = 0; play(); return; }
    if (paused) { paused = false; play(); }
    else { paused = true; halt(); render(); }
  });
  $('[data-prev]', s.el).addEventListener('click', () => jump(idx - 1));
  $('[data-next]', s.el).addEventListener('click', () => jump(idx + 1));
  $('[data-restart]', s.el)?.addEventListener('click', (e) => { e.target.closest('.listen-resume')?.remove(); jump(0); });
  $('[data-stop]', s.el).addEventListener('click', () => s.close());
  $('[data-rate]', s.el).addEventListener('change', (e) => {
    rate = parseFloat(e.target.value) || 1;
    if (!paused && !finished) { halt(); play(); } // a nova velocidade vale já na frase atual
  });
  s.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-size]');
    if (!b) return;
    size = Math.max(-1, Math.min(4, size + parseInt(b.dataset.size, 10)));
    try { localStorage.setItem('editorpdf.listen.size', String(size)); } catch { /* ok */ }
    applySize();
  });

  play();
}

