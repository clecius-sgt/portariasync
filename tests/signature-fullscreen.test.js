const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const capture = require('../label-capture');

const source = fs.readFileSync(path.join(__dirname, '..', 'label-capture.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('assinatura ocupa a viewport sem acionar fullscreen nativo do navegador', () => {
  assert.equal(capture.fullscreenLandscapeSignature, true);
  assert.equal(capture.nativeFullscreenApi, false);
  assert.equal(typeof capture.installFullscreenSignatureMode, 'function');
  assert.equal(typeof capture.abrirAssinaturaTelaCheia, 'function');
  assert.doesNotMatch(source, /requestFullscreen/);
  assert.doesNotMatch(source, /exitFullscreen/);
  assert.match(source, /position:fixed;inset:0;width:100dvw;height:100dvh/);
  assert.match(source, /orientation\.lock\('landscape'\)/);
  assert.match(source, /canvasAssinaturaTelaCheia/);
  assert.match(source, /Assinar em tela cheia/);
});

test('assinatura continua obrigatória antes de confirmar retirada', () => {
  assert.match(index, /if \(!window\._assinaturaData\)/);
  assert.match(index, /A assinatura é obrigatória para confirmar a retirada/);
});

test('canvas de assinatura bloqueia gesto de rolagem', () => {
  assert.match(source, /touch-action:none/);
  assert.match(source, /pointerdown/);
  assert.match(source, /pointermove/);
});

test('assinatura é compactada antes de ser armazenada', () => {
  assert.equal(typeof capture.exportarAssinaturaCompacta, 'function');
  assert.match(source, /900 \/ originalW/);
  assert.match(source, /360 \/ originalH/);
  assert.match(source, /image\/jpeg/);
  assert.match(source, /0\.65/);
});

test('fechamento remove imediatamente a camada de assinatura sem chamar fullscreen nativo', async () => {
  let removido = false;
  let destruido = false;
  let unlockChamado = false;
  const overlay = {
    style: {},
    _bodyOverflowAnterior: 'auto',
    _signatureController: { destruir() { destruido = true; } },
    remove() { removido = true; }
  };
  const doc = {
    body: { style: { overflow: 'hidden' } },
    getElementById(id) { return id === 'modalAssinaturaTelaCheia' ? overlay : null; }
  };
  const host = { screen: { orientation: { unlock() { unlockChamado = true; } } } };

  const fechamento = capture.fecharAssinaturaTelaCheia(doc, host);
  assert.equal(destruido, true);
  assert.equal(removido, true);
  assert.equal(overlay.style.display, 'none');
  assert.equal(doc.body.style.overflow, 'auto');
  assert.equal(unlockChamado, true);
  assert.ok(fechamento instanceof Promise);
});

test('falha de quota ao confirmar retirada não deixa modal travado', () => {
  let fechou = false;
  let sincronizou = false;
  let renderizou = 0;
  let toast = '';
  const quota = new Error('quota');
  quota.name = 'QuotaExceededError';
  const host = {
    confirmarRetirada() { throw quota; },
    agendarSyncEstadoServidor() { sincronizou = true; },
    fecharModalRetirada() { fechou = true; },
    renderEncomendas() { renderizou++; },
    renderDashboard() { renderizou++; },
    toast(msg) { toast = msg; },
    console: { error() {} }
  };
  assert.equal(capture.installRetiradaConfirmationGuard(host), true);
  assert.equal(host.confirmarRetirada('abc'), true);
  assert.equal(fechou, true);
  assert.equal(sincronizou, true);
  assert.equal(renderizou, 2);
  assert.match(toast, /Retirada confirmada/);
});
