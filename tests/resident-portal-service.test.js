'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ResidentPortalService,
  phonesMatch,
  cleanPackage,
  activeAuthorization,
  finalizePackageAuthorizations
} = require('../resident-portal-service');

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

test('morador cria e cancela autorização digital apenas para a própria encomenda', async () => {
  let now = Date.parse('2026-09-03T20:00:00Z');
  const sent = [];
  let writes = 0;
  const state = {
    version: 1,
    auditoria: [],
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
    readState: async associationId => {
      assert.equal(associationId, 'principal');
      return state;
    },
    writeState: async (associationId, value) => {
      assert.equal(associationId, 'principal');
      assert.equal(value, state);
      writes++;
    },
    sendText: async (phone, message) => sent.push({ phone, message }),
    codeGenerator: () => '111111',
    authorizationCodeGenerator: () => '482731',
    randomBytes: size => Buffer.alloc(size, 5),
    now: () => now,
    cooldownMs: 1
  });

  const request = await service.requestCode('17999998888', 'x', 'principal');
  const verified = await service.verify(request.challengeId, '111111');
  sent.length = 0;

  const created = await service.authorizeThirdParty(verified.token, 'p1', {
    nome: 'Maria de Souza',
    documento: 'RG 12.345.678-X',
    validadeHoras: 24
  });
  assert.equal(created.ok, true);
  assert.equal(created.codigo, '482731');
  assert.equal(created.autorizacao.status, 'ativa');
  assert.equal(created.autorizacao.documentoMascarado, '***678X');
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /Código de autorização: 482731/);
  assert.equal(writes, 1);
  assert.equal(state.auditoria.at(-1).acao, 'Autorização digital de retirada criada');

  const raw = activeAuthorization(state.encomendas[0], now);
  assert.ok(raw.codigoHash);
  assert.ok(raw.codigoSalt);
  const clean = cleanPackage(state.encomendas[0], now);
  assert.equal(clean.autorizacaoTerceiro.nome, 'Maria de Souza');
  assert.equal(JSON.stringify(clean).includes('codigoHash'), false);
  assert.equal(JSON.stringify(clean).includes('482731'), false);

  await assert.rejects(
    () => service.authorizeThirdParty(verified.token, 'p2', { nome:'Pessoa X', documento:'1234' }),
    /Encomenda não encontrada/
  );

  const cancelled = await service.cancelThirdPartyAuthorization(verified.token, 'p1');
  assert.equal(cancelled.ok, true);
  assert.equal(state.encomendas[0].autorizacoesRetirada.at(-1).status, 'cancelada');
  assert.equal(state.auditoria.at(-1).acao, 'Autorização digital de retirada cancelada');
  assert.equal(writes, 2);
});

test('portaria valida código e documento da autorização sem atravessar associação', async () => {
  const now = Date.parse('2026-09-03T20:00:00Z');
  let writes = 0;
  const states = {
    principal: {
      version: 1,
      auditoria: [],
      moradores: [{ id:'m1', nome:'Ana', casa:'Rua A, 1', whats:'17999998888' }],
      encomendas: [{ id:'p1', codigo:'A1', status:'pendente', moradorId:'m1', moradorNome:'Ana', moradorCasa:'Rua A, 1' }]
    },
    outra: {
      version: 1,
      auditoria: [],
      moradores: [],
      encomendas: []
    }
  };
  const service = new ResidentPortalService({
    readState: async id => states[id],
    writeState: async () => { writes++; },
    sendText: async () => {},
    codeGenerator: () => '111111',
    authorizationCodeGenerator: () => '975310',
    randomBytes: size => Buffer.alloc(size, 6),
    now: () => now,
    cooldownMs: 1
  });
  const request = await service.requestCode('17999998888', 'x', 'principal');
  const verified = await service.verify(request.challengeId, '111111');
  await service.authorizeThirdParty(verified.token, 'p1', { nome:'Carlos Pereira', documento:'CNH 99887766', validadeHoras:24 });
  writes = 0;

  await assert.rejects(
    () => service.verifyThirdPartyAuthorization('outra', 'p1', { codigo:'975310', documento:'CNH 99887766' }, { nome:'Porteiro' }),
    /Encomenda pendente não encontrada/
  );
  await assert.rejects(
    () => service.verifyThirdPartyAuthorization('principal', 'p1', { codigo:'000000', documento:'CNH 99887766' }, { nome:'Porteiro' }),
    /Código ou documento/
  );

  const result = await service.verifyThirdPartyAuthorization(
    'principal', 'p1', { codigo:'975310', documento:'CNH 99887766' }, { nome:'Porteiro 01' }
  );
  assert.equal(result.ok, true);
  assert.equal(result.nome, 'Carlos Pereira');
  assert.equal(result.documentoMascarado, '***7766');
  assert.equal(activeAuthorization(states.principal.encomendas[0], now).validadaPor, 'Porteiro 01');
  assert.ok(writes >= 2);
});

test('autorização validada vira utilizada quando a encomenda é retirada', () => {
  const item = {
    id:'p1', status:'retirado', dataRetirada:'03/09/2026 18:30',
    autorizacoesRetirada:[{
      id:'a1', nome:'Maria', documento:'1234', status:'ativa',
      criadaEm:'2026-09-03T18:00:00Z', expiraEm:'2026-09-04T18:00:00Z', validadaEm:'2026-09-03T21:29:00Z'
    }]
  };
  finalizePackageAuthorizations(item, Date.parse('2026-09-03T21:30:00Z'));
  assert.equal(item.autorizacoesRetirada[0].status, 'utilizada');
  assert.equal(item.autorizacoesRetirada[0].utilizadaEm, '03/09/2026 18:30');
});

test('cleanPackage não expõe PIN, assinatura, fotos nem segredo da autorização', () => {
  const item = cleanPackage({
    id:'p', codigo:'1', pinRetirada:'999999', assinatura:'data:x', fotoEtiqueta:'data:y', fotoRetirante:'data:z',
    autorizacoesRetirada:[{
      id:'a', nome:'Maria', documento:'RG12345678', status:'ativa', criadaEm:'2026-09-03T18:00:00Z',
      expiraEm:'2099-09-04T18:00:00Z', codigoSalt:'segredo', codigoHash:'hash-secreto'
    }]
  });
  assert.equal(Object.hasOwn(item, 'pinRetirada'), false);
  assert.equal(Object.hasOwn(item, 'assinatura'), false);
  assert.equal(Object.hasOwn(item, 'fotoEtiqueta'), false);
  assert.equal(Object.hasOwn(item, 'fotoRetirante'), false);
  assert.equal(JSON.stringify(item).includes('codigoSalt'), false);
  assert.equal(JSON.stringify(item).includes('codigoHash'), false);
  assert.equal(item.autorizacaoTerceiro.documentoMascarado, '***5678');
});
