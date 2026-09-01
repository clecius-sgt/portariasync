// All recognition assets are served by our own server. No runtime CDN or API.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const destination = path.join(root, 'vendor');
function copy(source, target) {
  const to = path.join(destination, target);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(root, 'node_modules', source), to);
}
for (const file of ['tesseract.min.js', 'worker.min.js', 'tesseract.min.js.LICENSE.txt', 'worker.min.js.LICENSE.txt']) {
  copy('tesseract.js/dist/' + file, 'ocr/' + file);
}
copy('tesseract.js/LICENSE.md', 'ocr/LICENSE-tesseract.md');
copy('tesseract.js-core/LICENSE', 'ocr/core/LICENSE');
for (const file of fs.readdirSync(path.join(root, 'node_modules/tesseract.js-core'))) {
  if (/^tesseract-core.*\.wasm(?:\.js)?$/.test(file)) copy('tesseract.js-core/' + file, 'ocr/core/' + file);
}
copy('@tesseract.js-data/por/4.0.0_best_int/por.traineddata.gz', 'ocr/lang/por.traineddata.gz');
copy('@zxing/library/umd/index.min.js', 'barcode/zxing.min.js');
copy('@zxing/library/LICENSE', 'barcode/LICENSE');
console.log('Leitores locais preparados em vendor/.');
