// Junta os idiomas do OCR (português + inglês) numa pasta só, usada pelo app e pelo instalador
import fs from 'node:fs/promises';
import path from 'node:path';
const dest = path.resolve('vendor/tessdata');
await fs.mkdir(dest, { recursive: true });
for (const lang of ['por', 'eng']) {
  await fs.copyFile(path.resolve(`node_modules/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`), path.join(dest, `${lang}.traineddata.gz`));
}
console.log('idiomas do OCR em', dest);
