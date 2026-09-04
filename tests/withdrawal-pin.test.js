const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pin = require('../withdrawal-pin');
const whatsapp = require('../whatsapp-client');

const root = path.join(__dirname, '..');

test('gera PIN numérico de seis dígitos com fonte criptográfica quando disponível', () => {
  const host = {
    crypto: {
      getRandomValues(arr) {
        arr[0] = 123456789;
        return arr;
      }
    }
  };
  const value = pin.generatePin(host);
  assert.match(value, /^\d{6}$/);
  assert.notEqual(value[0], '0');
});

test('normaliza e valida PIN somente quando o aviso foi enviado', () => {
  const enc = { status: 'pendente', pinRetirada: '123456', pinRetiradaEnviado: true };
  assert.equal(pin.normalizePin('12 34-56'), '123456');
  assert.equal(pin.pinRequired(enc), true);
  assert.equal(pin.validatePin(enc, '123456'), true);
  assert.equal(pin.validatePin(enc, '123457'), false);
  assert.equal(pin.pinRequired({ ...enc, pinRetiradaEnviado: false }), false);
});

test('autorização digital ativa substitui o PIN apenas para o terceiro correto e com validador carregado', () => {
  const enc = {
    status: 'pendente',
    pinRetirada: '123456',
    pinRetiradaEnviado: true,
    autorizacoesRetirada: [{
      id: 'a1', nome: 'Maria Souza', documento: 'RG12345678X', status: 'ativa',
      criadaEm: '2026-09-03T18:00:00Z', expiraEm: '2099-09-04T18:00:00Z'
    }]
  };
  const correct = { __withdrawalAuthorizationInstalled:true, _retiranteTipo: 'outro', _retiranteRg: 'RG 12.345.678-X' };
  const wrong = { __withdrawalAuthorizationInstalled:true, _retiranteTipo: 'outro', _retiranteRg: 'RG 99.999.999-9' };
  const owner = { __withdrawalAuthorizationInstalled:true, _retiranteTipo: 'proprio', _retiranteRg: '' };
  const validatorMissing = { _retiranteTipo:'outro', _retiranteRg:'RG 12.345.678-X' };
  assert.equal(pin.digitalAuthorizationApplies(enc, correct), true);
  assert.equal(pin.digitalAuthorizationApplies(enc, wrong), false);
  assert.equal(pin.digitalAuthorizationApplies(enc, owner), false);
  assert.equal(pin.digitalAuthorizationApplies(enc, validatorMissing), false);
  assert.equal(pin.pinRequired(enc), true);
});

test('mensagem adiciona PIN uma única vez sem expor controles internos', () => {
  const message = pin.appendPinMessage('Chegou uma encomenda.', '654321');
  assert.match(message, /PIN de retirada: 654321/);
  assert.equal((message.match(/654321/g) || []).length, 1);
  assert.equal(pin.appendPinMessage(message, '654321'), message);
});

test('cliente WhatsApp gera, persiste e envia PIN junto com aviso da encomenda', async () => {
  let body = null;
  let saves = 0;
  const host = {
    config: {},
    crypto: { getRandomValues(arr) { arr[0] = 42; return arr; } },
    salvarEncomendas() { saves++; },
    apiFetch: async (url, options) => {
      assert.equal(url, '/api/whatsapp/package');
      body = JSON.parse(options.body);
      return { ok: true };
    },
    toast() {},
    console
  };
  const morador = { nome: 'Morador Teste', casa: 'Casa 1', whats: '11999999999' };
  const enc = { codigo: 'ABC123456', transportadora: 'Teste', status: 'pendente' };
  const ok = await whatsapp.sendPackage(host, morador, enc);
  assert.equal(ok, true);
  assert.match(enc.pinRetirada, /^\d{6}$/);
  assert.equal(enc.pinRetiradaEnviado, true);
  assert.equal(body.pin, enc.pinRetirada);
  assert.match(body.mensagem, new RegExp('PIN de retirada: ' + enc.pinRetirada));
  assert.ok(saves >= 2);
});

test('falha no WhatsApp mantém PIN mas não torna sua validação obrigatória', async () => {
  const host = {
    config: {},
    crypto: { getRandomValues(arr) { arr[0] = 99; return arr; } },
    salvarEncomendas() {},
    apiFetch: async () => ({ ok: false }),
    toast() {},
    console: { error() {} }
  };
  const enc = { codigo: 'XYZ123456', transportadora: 'Teste', status: 'pendente' };
  const ok = await whatsapp.sendPackage(host, { nome: 'Teste', casa: 'Casa', whats: '11999999999' }, enc);
  assert.equal(ok, false);
  assert.match(enc.pinRetirada, /^\d{6}$/);
  assert.equal(enc.pinRetiradaEnviado, false);
  assert.equal(pin.pinRequired(enc), false);
});

test('PWA carrega módulo do PIN e mantém API e dados fora do cache', () => {
  const pwaSource = fs.readFileSync(path.join(root, 'pwa.js'), 'utf8');
  const swSource = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.equal(pin.VERSION, '2026-09-03.2');
  assert.match(pwaSource, /withdrawal-pin\.js\?v=20260903-1/);
  assert.match(pwaSource, /loadWithdrawalPin\(host\)/);
  assert.match(swSource, /withdrawal-pin\.js/);
  assert.match(swSource, /portariasync-shell-v3/);
  assert.match(swSource, /url\.pathname\.startsWith\('\/api\/'\).*return false/);
  assert.match(swSource, /url\.pathname\.startsWith\('\/data\/'\).*return false/);
});
