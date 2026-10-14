// Cliente do motor PDF: cria o worker na primeira chamada e devolve uma promessa por operação.
// onProgress recebe { message, vars } (mensagem em português, traduzida com t()).
let worker = null;
let seq = 0;
const pending = new Map();

function start() {
  worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const job = pending.get(data.id);
    if (!job) return;
    if (data.progress) return job.onProgress?.(data.progress);
    pending.delete(data.id);
    if (data.error) job.reject(new Error(data.error)); else job.resolve(data.result);
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || 'falha no motor');
    pending.forEach((job) => job.reject(err));
    pending.clear();
    worker.terminate();
    worker = null;
  };
}

export function engine(op, args = {}, onProgress) {
  if (!worker) start();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, op, args });
  });
}
