'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ResidentPortalService, phonesMatch, cleanPackage } = require('../resident-portal-service');

test('normaliza telefones brasileiros com e sem 55', () => {
  assert.equal(phonesMatch('17999998888', '5517999998888'), true);
  assert.equal(phonesMatch('(17) 99999-8888', '17999998888'), true);
  assert.equal(phonesMatch('17999998888', '11999998888'), false);
});

test('login por OTP libera apenas moradores do telefone validado', async () => {
  let now = 1000;
  const sent = [];
  const state = {
    moradores: [
      { id: 'm1', nome: 'Ana Silva', casa: 'Rua A, 1', whats: '17999998888' },
      { id: 'm2', nome: 'Bruno Souza', casa: 'Rua B, 2', whats: '17888887777' }
    ],
    encomendas: [
      { id: 'p1', codigo: 'ABC12345', status: 'pendente', moradorId: 'm1', moradorNome: 'Ana Silva', moradorCasa: 'Rua A, 1', pinRetirada: '123456', pinRetiradaEnviado: true },
      { id: 'p2', codigo: 'XYZ98765', status: 'pendente', moradorId: 'm2', moradorNome: 'Bruno Souza', moradorCasa: 'Rua B, 2' }
    ]
  };
  const service = new ResidentPortalService({
    readState: async () => state,
    writeState: async () => {},
    sendText: async (phone, message) => sent.push({ phone, message }),
    codeGenerator: () => '654321',
    randomBytes: size => Buffer.alloc(size, 7),
    now: () => now,
    cooldownMs: 1
  });

  const request = await service.requestCode('5517999998888', '127.0.0.1');
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /654321/);

  const verified = await service.verify(request.challengeId, '654321');
  const me = await service.profile(verified.token);
  const packages = await service.packages(verified.token);

  assert.deepEqual(me.residents.map(x => x.id), ['m1']);
  assert.equal(me.summary.pendentes, 1);
  assert.deepEqual(packages.packages.map(x => x.id), ['p1']);
  assert.equal(Object.hasOwn(packages.packages[0], 'pinRetirada'), false);
  assert.equal(packages.packages[0].pinAtivo, true);

  now += 12 * 60 * 60 * 1000 + 1;
  await assert.rejects(() => service.profile(verified.token), /Sessão expirada/);
});

test('número não cadastrado não revela existência e não envia código', async () => {
  let sent = 0;
  const service = new ResidentPortalService({
    readState: async () => ({ moradores: [], encomendas: [] }),
    writeState: async () => {},
    sendText: async () => { sent++; },
    codeGenerator: () => '111111',
    randomBytes: size => Buffer.alloc(size, 3),
    cooldownMs: 1
  });
  const result = await service.requestCode('17999990000', 'x');
  assert.equal(result.ok, true);
  assert.match(result.message, /Se o número estiver cadastrado/);
  assert.equal(sent, 0);
  await assert.rejects(() => service.verify(result.challengeId, '111111'), /Código inválido/);
});

test('morador pode reenviar PIN apenas de sua própria encomenda pendente', async () => {
  const sent = [];
  let writes = 0;
  const state = {
    version: 1,
    moradores: [
      { id: 'm1', nome: 'Ana Silva', casa: 'Rua A, 1', whats: '17999998888' },
      { id: 'm2', nome: 'Bruno Souza', casa: 'Rua B, 2', whats: '17888887777' }
    ],
    encomendas: [
      { id: 'p1', codigo: 'COD001234', status: 'pendente', moradorId: 'm1', moradorNome: 'Ana Silva', moradorCasa: 'Rua A, 1' },
      { id: 'p2', codigo: 'COD009999', status: 'pendente', moradorId: 'm2', moradorNome: 'Bruno Souza', moradorCasa: 'Rua B, 2' }
    ]
  };
  const service = new ResidentPortalService({
    readState: async () => state,
    writeState: async () => { writes++; },
    sendText: async (phone, message) => sent.push({ phone, message }),
    codeGenerator: () => '246810',
    randomBytes: size => Buffer.alloc(size, 9),
    cooldownMs: 1
  });
  const request = await service.requestCode('17999998888', 'x');
  const verified = await service.verify(request.challengeId, '246810');
  sent.length = 0;

  const result = await service.resendPin(verified.token, 'p1');
  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /PIN de retirada: 246810/);
  assert.equal(state.encomendas[0].pinRetiradaEnviado, true);
  assert.equal(writes, 1);
  await assert.rejects(() => service.resendPin(verified.token, 'p2'), /Encomenda não encontrada/);
});

test('cleanPackage não expõe PIN, assinatura ou fotos', () => {
  const item = cleanPackage({ id:'p', codigo:'1', pinRetirada:'999999', assinatura:'data:x', fotoEtiqueta:'data:y', fotoRetirante:'data:z' });
  assert.equal(Object.hasOwn(item, 'pinRetirada'), false);
  assert.equal(Object.hasOwn(item, 'assinatura'), false);
  assert.equal(Object.hasOwn(item, 'fotoEtiqueta'), false);
  assert.equal(Object.hasOwn(item, 'fotoRetirante'), false);
});
