const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'paddleocr_worker.py'), 'utf8');

test('PaddleOCR usa detector mobile PP-OCRv5 por padrão', () => {
  assert.match(source, /DEFAULT_DET_MODEL\s*=\s*["']PP-OCRv5_mobile_det["']/);
  assert.match(source, /DEFAULT_REC_MODEL\s*=\s*["']latin_PP-OCRv5_mobile_rec["']/);
});

test('PaddleOCR mantém módulos geométricos desligados e limita imagem para CPU', () => {
  assert.match(source, /use_doc_orientation_classify=False/);
  assert.match(source, /use_doc_unwarping=False/);
  assert.match(source, /use_textline_orientation=False/);
  assert.match(source, /PADDLE_OCR_MAX_SIDE["'],\s*["']960["']/);
  assert.match(source, /text_det_limit_type=["']max["']/);
});
