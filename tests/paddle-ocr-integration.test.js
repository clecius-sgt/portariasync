const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const capture = require('../label-capture');
const { PaddleOcrClient, parseImageDataUrl } = require('../paddle-ocr-client');

test('Paddle OCR image parser accepts camera JPEG and rejects arbitrary payloads', () => {
  const parsed = parseImageDataUrl('data:image/jpeg;base64,' + Buffer.from('fake-jpeg').toString('base64'));
  assert.equal(parsed.ext, 'jpeg');
  assert.equal(parsed.buffer.toString(), 'fake-jpeg');
  assert.throws(() => parseImageDataUrl('data:text/plain;base64,SGVsbG8='), /Imagem inválida/);
});

test('Paddle OCR client reports missing VPS environment without starting Python', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portariasync-paddle-test-'));
  const client = new PaddleOcrClient({ baseDir: dir });
  assert.deepEqual(client.status(), { installed: false, running: false, ready: false, pending: 0 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('browser client sends the photo to authenticated PaddleOCR endpoint', async () => {
  let request;
  const host = {
    localStorage: {
      getItem(key) {
        if (key === 'authToken') return 'token-123';
        if (key === 'apiBaseUrl') return 'https://example.test';
        return '';
      }
    },
    fetch: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: { text: 'Carlos Augusto\nRua Londres 160', confidence: 96, lines: ['Carlos Augusto', 'Rua Londres 160'] } })
      };
    }
  };
  const status = { textContent: '' };
  const result = await capture.recognizeWithPaddle('data:image/jpeg;base64,ZmFrZQ==', status, host);
  assert.equal(request.url, 'https://example.test/api/ocr-paddle');
  assert.equal(request.options.headers.Authorization, 'Bearer token-123');
  assert.match(request.options.body, /imagemBase64/);
  assert.equal(result.engine, 'paddleocr');
  assert.match(result.text, /Rua Londres 160/);
});

test('Paddle wrapper injects server OCR result into existing recipient workflow', async () => {
  let received;
  const host = {
    localStorage: { getItem: key => key === 'authToken' ? 'abc' : '' },
    fetch: async () => ({
      ok: true,
      json: async () => ({ result: { text: 'Carlos Augusto\nRua Londres 160', confidence: 94, lines: [] } })
    }),
    enviarParaOCR: async (...args) => { received = args; return 'ok'; }
  };
  assert.equal(capture.installPaddleOcrMode(host), true);
  const status = { textContent: '' };
  const value = await host.enviarParaOCR('data:image/jpeg;base64,ZmFrZQ==', status, null, '', 7);
  assert.equal(value, 'ok');
  assert.equal(received[4], 7);
  assert.equal(received[5].engine, 'paddleocr');
  assert.match(received[5].text, /Carlos Augusto/);
});

test('server exposes protected PaddleOCR route and health state', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /\/api\/ocr-paddle/);
  assert.match(source, /requireRole\(req, \['admin', 'porteiro'\]\)/);
  assert.match(source, /paddleocr: paddleOcr\.status\(\)/);
});
