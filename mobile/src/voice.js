// Voz no app: ler o PDF em voz alta, no idioma do próprio documento.
// Usa a voz do celular (TTS nativo / speechSynthesis) — roda localmente, sem custo e sem servidor.
import { Capacitor } from '@capacitor/core';
import { TextToSpeech } from '@capacitor-community/text-to-speech';
import { t, getLang } from './i18n.js';
import { $, esc, sheet, toast, busy } from './ui.js';
import { engine } from './engine.js';

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
  if (native) { openReadingSheetNative({ chunks, lang, truncated }); return; }

  const voices = await ensureVoices();
  const voice = pickVoice(voices, lang);
  if (!voice) toast(t('Não há voz instalada para {idioma}; vou ler com a voz padrão.', { idioma: LANG_NAME[lang] || lang }));
  openReadingSheetWeb({ synth, chunks, lang, voice, truncated });
}

// Painel de controle da leitura (pausar/continuar/parar/velocidade).
function openReadingSheetWeb({ synth, chunks, lang, voice, truncated }) {
  const name = LANG_NAME[lang] || lang;
  let idx = 0, rate = 1, finished = false;

  const content = `
    <p class="sheet-text" data-status></p>
    ${truncated ? `<p class="form-note">${esc(t('Documento muito longo: vou ler apenas o começo.'))}</p>` : ''}
    <label class="field"><span>${esc(t('Velocidade'))}</span>
      <select data-rate>
        <option value="0.75">0,75×</option>
        <option value="1" selected>1×</option>
        <option value="1.25">1,25×</option>
        <option value="1.5">1,5×</option>
      </select>
    </label>
    <div class="sheet-actions">
      <button class="btn btn-primary" data-pause>${esc(t('Pausar'))}</button>
      <button class="btn btn-secondary" data-stop>${esc(t('Parar'))}</button>
    </div>`;

  const s = sheet(content, {
    title: t('Lendo em voz alta'),
    onClose: () => { try { synth.cancel(); } catch { /* ok */ } },
  });

  const statusEl = $('[data-status]', s.el);
  const pauseBtn = $('[data-pause]', s.el);
  const setStatus = () => {
    statusEl.textContent = finished
      ? t('Leitura concluída.')
      : `${t('Lendo em {idioma}', { idioma: name })} — ${Math.min(idx + 1, chunks.length)}/${chunks.length}`;
  };
  setStatus();

  function speakNext() {
    if (finished) return;
    if (idx >= chunks.length) { finished = true; pauseBtn.disabled = true; setStatus(); return; }
    const u = new SpeechSynthesisUtterance(chunks[idx]);
    if (voice) u.voice = voice;
    u.lang = voice?.lang || bcp47(lang);
    u.rate = rate;
    u.onend = () => { if (!finished) { idx++; setStatus(); speakNext(); } };
    u.onerror = () => { if (!finished) { idx++; speakNext(); } };
    try { synth.speak(u); } catch { finished = true; }
  }

  pauseBtn.addEventListener('click', () => {
    if (finished) return;
    if (synth.paused) { synth.resume(); pauseBtn.textContent = t('Pausar'); }
    else { synth.pause(); pauseBtn.textContent = t('Continuar'); }
  });
  $('[data-stop]', s.el).addEventListener('click', () => s.close());
  $('[data-rate]', s.el).addEventListener('change', (e) => {
    rate = parseFloat(e.target.value) || 1;
    // a nova velocidade vale a partir da próxima frase
    if (!finished && !synth.paused) { try { synth.cancel(); } catch { /* ok */ } speakNext(); }
  });

  speakNext();
}

// Leitura no celular com o TTS nativo (Android/iOS). O sistema não tem pausa real:
// "Pausar" interrompe e guarda a frase atual; "Continuar" retoma a partir dela.
function openReadingSheetNative({ chunks, lang, truncated }) {
  const name = LANG_NAME[lang] || lang;
  const loc = bcp47Full(lang);
  let idx = 0, rate = 1, finished = false, paused = false, stopped = false;

  const content = `
    <p class="sheet-text" data-status></p>
    ${truncated ? `<p class="form-note">${esc(t('Documento muito longo: vou ler apenas o começo.'))}</p>` : ''}
    <label class="field"><span>${esc(t('Velocidade'))}</span>
      <select data-rate>
        <option value="0.75">0,75×</option>
        <option value="1" selected>1×</option>
        <option value="1.25">1,25×</option>
        <option value="1.5">1,5×</option>
      </select>
    </label>
    <div class="sheet-actions">
      <button class="btn btn-primary" data-pause>${esc(t('Pausar'))}</button>
      <button class="btn btn-secondary" data-stop>${esc(t('Parar'))}</button>
    </div>`;

  const s = sheet(content, {
    title: t('Lendo em voz alta'),
    onClose: () => { stopped = true; TextToSpeech.stop().catch(() => { /* ok */ }); },
  });

  const statusEl = $('[data-status]', s.el);
  const pauseBtn = $('[data-pause]', s.el);
  const setStatus = () => {
    statusEl.textContent = finished
      ? t('Leitura concluída.')
      : `${t('Lendo em {idioma}', { idioma: name })} — ${Math.min(idx + 1, chunks.length)}/${chunks.length}`;
  };
  setStatus();

  async function loop() {
    while (!stopped && !paused && idx < chunks.length) {
      setStatus();
      try {
        await TextToSpeech.speak({ text: chunks[idx], lang: loc, rate });
      } catch (err) {
        if (stopped || paused) return; // parar/pausar cancelam a fala e caem aqui
        if (idx === 0) {               // falhou já na 1ª frase: idioma/voz indisponível
          console.error(err);
          toast(t('Não há voz instalada para {idioma}; instale a voz nas configurações do aparelho.', { idioma: name }), 'error');
          stopped = true; s.close(); return;
        }
        // uma frase solta falhou: pula para a próxima
      }
      if (stopped || paused) return;
      idx++;
    }
    if (!stopped && !paused && idx >= chunks.length) { finished = true; pauseBtn.disabled = true; setStatus(); }
  }

  pauseBtn.addEventListener('click', () => {
    if (finished) return;
    if (paused) { paused = false; pauseBtn.textContent = t('Pausar'); loop(); }
    else { paused = true; pauseBtn.textContent = t('Continuar'); TextToSpeech.stop().catch(() => { /* ok */ }); }
  });
  $('[data-stop]', s.el).addEventListener('click', () => s.close());
  $('[data-rate]', s.el).addEventListener('change', (e) => { rate = parseFloat(e.target.value) || 1; });

  loop();
}
