const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const capture = require('../label-capture');

const source = fs.readFileSync(path.join(__dirname, '..', 'label-capture.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('assinatura fullscreen em paisagem está habilitada', () => {
  assert.equal(capture.fullscreenLandscapeSignature, true);
  assert.equal(typeof capture.installFullscreenSignatureMode, 'function');
  assert.equal(typeof capture.abrirAssinaturaTelaCheia, 'function');
  assert.match(source, /requestFullscreen/);
  assert.match(source, /orientation\.lock\('landscape'\)/);
  assert.match(source, /canvasAssinaturaTelaCheia/);
  assert.match(source, /Assinar em tela cheia/);
});

test('assinatura continua obrigatória antes de confirmar retirada', () => {
  assert.match(index, /if \(!window\._assinaturaData\)/);
  assert.match(index, /A assinatura é obrigatória para confirmar a retirada/);
});

test('canvas fullscreen bloqueia gesto de rolagem durante assinatura', () => {
  assert.match(source, /touch-action:none/);
  assert.match(source, /pointerdown/);
  assert.match(source, /pointermove/);
});
