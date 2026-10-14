// Motor PDF do app (MuPDF + Tesseract), o mesmo do desktop (engine/ops.mjs), rodando num Web Worker.
// O motor entra por import(): o MuPDF carrega com top-level await, e uma mensagem que chega antes de
// o onmessage existir se perde. Assim o onmessage existe desde o início e espera o motor ficar pronto.

// O worker fica em assets/ (build) ou src/ (dev); os arquivos do motor ficam em engine/ na raiz do app
const asset = (p) => new URL(p, new URL('engine/', new URL('..', self.location.href))).href;

const ready = import('../../engine/ops.mjs').then(({ ops, configure }) => {
  configure({
    tessdata: asset('tessdata'),
    tessGzip: false,
    maxPixels: 16e6, // celular: imagens menores que no computador (memória)
    tessWorker: asset('tesseract-worker.min.js'),
    tessCore: asset('core'),
    ocrFont: asset('LiberationSans-Regular.ttf'),
    srgb: asset('srgb.icc'),
    readFile: async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer()),
  });
  return ops;
});

self.onmessage = async ({ data: { id, op, args } }) => {
  try {
    const ops = await ready;
    if (!ops[op]) throw new Error(`operação desconhecida: ${op}`);
    const progress = (info) => self.postMessage({ id, progress: info });
    const result = await ops[op](args || {}, progress);
    const transfer = [];
    if (result?.bytes?.buffer) transfer.push(result.bytes.buffer);
    if (Array.isArray(result?.images)) result.images.forEach((b) => transfer.push(b.buffer));
    self.postMessage({ id, result }, transfer);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
