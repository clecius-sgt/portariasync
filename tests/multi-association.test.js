'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AssociationManager, DEFAULT_ASSOCIATION_ID } = require('../association-manager');
const { ResidentPortalService } = require('../resident-portal-service');

function stateWith(name, phone, packageId) {
  return {
    version: Date.now(),
    updatedAt: new Date().toISOString(),
    moradores: [{ id: 'm1', nome: name, casa: 'Rua Teste, 1', whats: phone }],
    encomendas: packageId ? [{ id: packageId, codigo: packageId, status: 'pendente', moradorId: 'm1', moradorNome: name, moradorCasa: 'Rua Teste, 1' }] : [],
    retirantesRelacionados: [],
    auditoria: [],
    detalhesRetirada: {},
    memoriaRemetentes: {},
    configPublica: {},
    resetEncomendasAt: null
  };
}

test('Multi-Associação mantém banco físico separado por associação', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portariasync-assoc-'));
  const manager = new AssociationManager({ dataDir: dir, defaultName: 'Associação Principal' });
  manager.writeState(DEFAULT_ASSOCIATION_ID, stateWith('Morador Principal', '17999990001', 'P1'));
  const second = manager.create({ id: 'jardim-sul', nome: 'Associação Jardim Sul' });
  manager.writeState(second.id, stateWith('Morador Jardim', '17999990002', 'J1'));

  const principal = manager.readState(DEFAULT_ASSOCIATION_ID);
  const jardim = manager.readState('jardim-sul');

  assert.deepEqual(principal.moradores.map(x => x.nome), ['Morador Principal']);
  assert.deepEqual(principal.encomendas.map(x => x.id), ['P1']);
  assert.deepEqual(jardim.moradores.map(x => x.nome), ['Morador Jardim']);
  assert.deepEqual(jardim.encomendas.map(x => x.id), ['J1']);
  assert.notEqual(manager.paths(DEFAULT_ASSOCIATION_ID).database, manager.paths('jardim-sul').database);
  assert.equal(manager.status(false).total, 2);
  manager.closeAll();
});

test('associação principal preserva caminhos legados do PortalSync', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portariasync-assoc-legacy-'));
  const manager = new AssociationManager({ dataDir: dir });
  assert.equal(manager.paths(DEFAULT_ASSOCIATION_ID).database, path.join(dir, 'portariasync.sqlite'));
  assert.equal(manager.paths(DEFAULT_ASSOCIATION_ID).mirror, path.join(dir, 'app-state.json'));
  manager.closeAll();
});

test('Portal do Morador não atravessa dados entre associações', async () => {
  const sent = [];
  const states = {
    principal: stateWith('Ana Principal', '17999998888', 'P1'),
    'jardim-sul': stateWith('Ana Jardim', '17999998888', 'J1')
  };
  const service = new ResidentPortalService({
    readState: async associationId => ({ ...states[associationId], associacao: { id: associationId, nome: associationId } }),
    writeState: async () => {},
    sendText: async (phone, message) => sent.push({ phone, message }),
    codeGenerator: () => '654321',
    randomBytes: size => Buffer.alloc(size, 8),
    cooldownMs: 1
  });

  const request = await service.requestCode('17999998888', 'x', 'jardim-sul');
  const verified = await service.verify(request.challengeId, '654321');
  const profile = await service.profile(verified.token);
  const packages = await service.packages(verified.token);

  assert.equal(profile.association.id, 'jardim-sul');
  assert.deepEqual(profile.residents.map(x => x.nome), ['Ana Jardim']);
  assert.deepEqual(packages.packages.map(x => x.id), ['J1']);
  assert.equal(packages.packages.some(x => x.id === 'P1'), false);
});

test('servidor expõe rotas de Multi-Associação e escopa app-state pela sessão', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /\/api\/associations/);
  assert.match(source, /switch-association/);
  assert.match(source, /readAppState\(session\.associacaoId\)/);
  assert.match(source, /writeAppState\(session\.associacaoId, state\)/);
  assert.match(source, /multiAssociation:\s*associations\.status/);
});

test('painel Multi-Associação permite criar, alternar e copiar portal', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'associacoes.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'associacoes.js'), 'utf8');
  assert.match(html, /Multi-Associação/);
  assert.match(js, /\/api\/associations/);
  assert.match(js, /switch-association/);
  assert.match(js, /morador\.html\?associacao=/);
});
