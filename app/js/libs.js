// Carrega as bibliotecas abertas usadas pelo editor e faz a configuração comum.
import * as pdfjs from '../../node_modules/pdfjs-dist/build/pdf.min.mjs';
import * as fabric from '../../node_modules/fabric/dist/index.min.mjs';

// pdf-lib e fontkit vêm em versões UMD (index.html), que já trazem as dependências embutidas
const { PDFLib, fontkit } = window;

const PDFJS_BASE = new URL('../../node_modules/pdfjs-dist/', import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'build/pdf.worker.min.mjs';

export function loadPdfjsDocument(bytes) {
  return pdfjs.getDocument({
    data: bytes.slice(), // o pdf.js toma posse do buffer; mandamos uma cópia
    cMapUrl: PDFJS_BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: PDFJS_BASE + 'standard_fonts/',
    wasmUrl: PDFJS_BASE + 'wasm/',
    iccUrl: PDFJS_BASE + 'iccs/',
    isEvalSupported: false,
    enableXfa: false,
  }).promise;
}

// Propriedades nossas que precisam sobreviver ao desfazer/refazer (toObject/loadFromJSON)
fabric.FabricObject.customProperties = ['kind', 'uid', 'link', 'runKey', 'tpl', 'field'];
// O fabric 7 usa o centro como origem por padrão; o editor trabalha com canto superior esquerdo
fabric.FabricObject.ownDefaults.originX = 'left';
fabric.FabricObject.ownDefaults.originY = 'top';
Object.assign(fabric.InteractiveFabricObject.ownDefaults, {
  transparentCorners: false,
  cornerColor: '#ffffff',
  cornerStrokeColor: '#1f5eff',
  borderColor: '#1f5eff',
  cornerSize: 9,
  padding: 2,
});

// Posição da linha de base do texto dentro de um IText do fabric (ver Text._renderTextCommon):
// baseline da linha i = topo + i * fontSize * 1.13 * lineHeight + fontSize * 1.13 * (1 - 0.222)
const TEXT_DEFAULTS = fabric.IText.getDefaults();
export const TEXT_BASELINE_RATIO = TEXT_DEFAULTS._fontSizeMult * (1 - TEXT_DEFAULTS._fontSizeFraction);
export const lineAdvance = (obj) => obj.fontSize * TEXT_DEFAULTS._fontSizeMult * obj.lineHeight;

let uidCounter = 0;
export const newUid = () => `o${Date.now().toString(36)}${(uidCounter++).toString(36)}`;

export { pdfjs, fabric, PDFLib, fontkit };
