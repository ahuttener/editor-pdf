// Thread do motor PDF: recebe pedidos do processo principal e executa as operações de engine/ops.mjs
import { parentPort, workerData } from 'node:worker_threads';
import { ops, configure } from './ops.mjs';

configure(workerData || {});

parentPort.on('message', async ({ id, op, args }) => {
  if (op === 'configure') { configure(args || {}); return; }
  try {
    if (!ops[op]) throw new Error(`operação desconhecida: ${op}`);
    const progress = (info) => parentPort.postMessage({ id, progress: info });
    const result = await ops[op](args || {}, progress);
    const transfer = [];
    if (result?.bytes) transfer.push(result.bytes.buffer);
    parentPort.postMessage({ id, result }, transfer);
  } catch (err) {
    parentPort.postMessage({ id, error: String(err?.message || err) });
  }
});
