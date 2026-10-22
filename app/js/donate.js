// Apoio (Buy Me a Coffee): cartão central IGUAL ao do site/app mobile.
// Mostra ao abrir o app desktop. Abre o link no navegador padrão via
// window.open -> setWindowOpenHandler (main.js) -> shell.openExternal.
const BMC_URL = 'https://buymeacoffee.com/cyberseinfo';

const CSS = `
.bmc-back{position:fixed;inset:0;z-index:9998;
  background:radial-gradient(120% 120% at 50% 50%,rgba(2,6,23,.55),rgba(2,6,23,.80));
  -webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);animation:bmcFade .4s ease both;}
@keyframes bmcFade{from{opacity:0}to{opacity:1}}
.bmc-card{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);
  width:min(400px,calc(100vw - 32px));z-index:9999;text-align:center;
  padding:26px 24px 24px;border-radius:22px;color:#e5e7eb;
  background:radial-gradient(130% 90% at 50% 0%,rgba(34,211,238,.12),transparent 60%),
    linear-gradient(160deg,#111827 0%,#0e1022 100%);
  border:1px solid rgba(34,211,238,.4);
  box-shadow:0 30px 80px -24px rgba(0,0,0,.85),0 0 70px -20px rgba(6,182,212,.55);
  animation:bmcPop .5s cubic-bezier(.16,.84,.44,1) both;}
.bmc-card::before{content:"";position:absolute;left:26px;right:26px;top:0;height:1px;
  background:linear-gradient(90deg,transparent,#22d3ee,transparent);opacity:.85;}
@keyframes bmcPop{from{opacity:0;transform:translate(-50%,-44%) scale(.94)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}
.bmc-card *{box-sizing:border-box;}
.bmc-card .bmc-logo{width:76px;height:76px;border-radius:18px;margin:0 auto 14px;display:block;
  filter:drop-shadow(0 0 16px rgba(34,195,255,.6));}
.bmc-card .bmc-lead{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:800;
  letter-spacing:.11em;text-transform:uppercase;color:#22d3ee;margin:0 0 8px;}
.bmc-card .bmc-lead svg{width:14px;height:14px;}
.bmc-card h2{margin:0 0 8px;font-size:21px;line-height:1.25;letter-spacing:-.01em;color:#fff;font-weight:800;}
.bmc-card p{margin:0 auto 20px;max-width:320px;font-size:14.5px;line-height:1.55;color:#d1d5db;}
.bmc-card p b{color:#fff;font-weight:700;}
.bmc-card .bmc-btn{display:inline-flex;align-items:center;justify-content:center;background:#ffdd00;
  border-radius:13px;padding:13px 22px;text-decoration:none;cursor:pointer;
  box-shadow:0 10px 24px -8px rgba(255,221,0,.6);}
.bmc-card .bmc-btn:active{transform:translateY(1px);}
.bmc-card .bmc-btn img{height:24px;display:block;}
.bmc-card .bmc-skip{display:block;margin:14px auto 0;background:transparent;border:0;color:#9ca3af;font-size:13px;cursor:pointer;font-family:inherit;}
.bmc-card .bmc-close{position:absolute;top:12px;right:14px;width:28px;height:28px;border-radius:9px;border:0;
  background:rgba(255,255,255,.06);color:#9ca3af;font-size:17px;line-height:1;cursor:pointer;display:grid;place-items:center;}
@media (prefers-reduced-motion:reduce){.bmc-card,.bmc-back{animation:none;}}
`;

let styled = false;
function ensureStyle() {
  if (styled) return;
  styled = true;
  const s = document.createElement('style');
  s.id = 'bmc-style';
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function maybeShowDonation() {
  if (document.querySelector('.bmc-card')) return;
  ensureStyle();

  const back = document.createElement('div');
  back.className = 'bmc-back';
  back.setAttribute('data-no-i18n', '');

  const card = document.createElement('aside');
  card.className = 'bmc-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', 'Support CyberSecInfo');
  card.setAttribute('data-no-i18n', '');
  card.innerHTML =
      '<button class="bmc-close" aria-label="Dismiss">&times;</button>'
    + '<img class="bmc-logo" src="img/cybersecinfo.png" alt="CyberSecInfo">'
    + '<span class="bmc-lead">'
    +   '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 8h12v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8Z" stroke="currentColor" stroke-width="1.8"/><path d="M16 9h2.5a2.5 2.5 0 0 1 0 5H16" stroke="currentColor" stroke-width="1.8"/><path d="M7 3.5c-.6.8-.6 1.4 0 2.2M11 3.5c-.6.8-.6 1.4 0 2.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
    +   'Enjoying CyberSecInfo?'
    + '</span>'
    + '<h2>Keep CyberSecInfo online</h2>'
    + '<p>If CyberSecInfo helped you in any way, <b>consider a contribution</b> to keep it online.</p>'
    + '<a class="bmc-btn" role="button" tabindex="0" aria-label="Buy me a coffee"><img src="img/bmc.svg" alt="Buy me a coffee"></a>'
    + '<button class="bmc-skip">Maybe later</button>';

  function hide() {
    back.remove();
    card.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); hide(); } }

  document.body.appendChild(back);
  document.body.appendChild(card);

  back.addEventListener('click', hide);
  card.querySelector('.bmc-close').addEventListener('click', hide);
  card.querySelector('.bmc-skip').addEventListener('click', hide);
  card.querySelector('.bmc-btn').addEventListener('click', () => { window.open(BMC_URL, '_blank', 'noopener'); hide(); });
  document.addEventListener('keydown', onKey);
}
