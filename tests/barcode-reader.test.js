const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const reader = require('../barcode-reader');

const TRACKING = 'TBR364591209';

test('QR estruturado extrai tracking sem depender de OCR', () => {
  assert.equal(reader.extractPayload(JSON.stringify({ tracking: TRACKING }), 'qr_code'), TRACKING);
  assert.equal(reader.normalizeCode(JSON.stringify({ tracking: TRACKING }), 'qr_code'), TRACKING);
});

test('QR com URL extrai apenas o código de rastreio e não grava a URL como encomenda', () => {
  assert.equal(reader.extractPayload('https://exemplo.test/rastreio?code=' + TRACKING, 'qr_code'), TRACKING);
  assert.equal(reader.normalizeCode('https://exemplo.test/pagina-sem-codigo', 'qr_code'), '');
});

test('código de barras linear permanece separado do texto OCR', () => {
  const item = reader.candidate('AB123456789BR', 'code_128', 'teste', null);
  assert.equal(item.codigo, 'AB123456789BR');
  assert.equal(item.tipo, 'barcode');
  assert.equal(item.leitorSeparado, true);
});

test('leitor nativo de QR vence sem chamar leitor legado', async () => {
  let legacyCalls = 0;
  class FakeImage {
    set src(value) {
      this._src = value;
      queueMicrotask(() => this.onload && this.onload());
    }
  }
  class FakeBarcodeDetector {
    static async getSupportedFormats() { return ['qr_code']; }
    constructor(options) { this.options = options; }
    async detect() { return [{ rawValue: JSON.stringify({ tracking: TRACKING }), format: 'qr_code' }]; }
  }
  const host = {
    Image: FakeImage,
    BarcodeDetector: FakeBarcodeDetector,
    normalizarCodigoBarras: value => value,
    pontuarCodigoBarras: () => 10
  };
  const result = await reader.scan('data:image/jpeg;base64,ZmFrZQ==', host, async () => {
    legacyCalls++;
    return { codigo: 'LEGACY123456' };
  });

  assert.equal(result.codigo, TRACKING);
  assert.equal(result.tipo, 'qr');
  assert.equal(result.origem, 'barcode/QR nativo');
  assert.equal(result.leitorSeparado, true);
  assert.equal(legacyCalls, 0);
});

test('instalação substitui somente a leitura de código e mantém fallback compatível', async () => {
  let legacyCalls = 0;
  const host = {
    detectarCodigoLivre: async () => {
      legacyCalls++;
      return { codigo: TRACKING, score: 20, origem: 'legado' };
    }
  };
  assert.equal(reader.install(host), true);
  assert.equal(host.__separateBarcodeReaderInstalled, true);
  assert.equal(host.detectarCodigoLivre.__separateBarcodeReader, true);
  const result = await host.detectarCodigoLivre('imagem');
  assert.equal(result.codigo, TRACKING);
  assert.equal(result.leitorSeparado, true);
  assert.equal(result.legado, true);
  assert.equal(legacyCalls, 1);
});

test('módulo de barcode/QR não chama Tesseract nem PaddleOCR', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'barcode-reader.js'), 'utf8');
  assert.doesNotMatch(source, /Tesseract/);
  assert.doesNotMatch(source, /PaddleOCR|recognizeWithPaddle/);
  assert.match(source, /BarcodeDetector/);
  assert.match(source, /ZXing/);
});

test('OCR local carrega o leitor separado depois que a aplicação está pronta', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'local-ocr.js'), 'utf8');
  assert.match(source, /barcode-reader\.js\?v=20260902-1/);
  assert.match(source, /loadSeparateBarcodeReaderScript\(root\)/);
  assert.match(source, /separateBarcodeReaderLoader:\s*true/);
  assert.match(source, /version:\s*'2026-09-02\.6'/);
});
