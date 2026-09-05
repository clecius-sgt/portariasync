'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ResidentManagementService, ARCHIVE_KEY, normalizePhone } = require('../resident-management-service');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

class FakeAssociations {
  constructor(state) { this.value = clone(state); }
  readState(id) { return { ...clone(this.value), associacao: { id, nome: 'Associação Teste' } }; }
  writeState(id, state) { this.value = clone(state); return this.readState(id); }
  publicInfo(id) { return { id, nome: 'Associação Teste' }; }
}

function baseState() {
  return {
    version: 1,
    updatedAt: '2026-09-05T00:00:00.000Z',
    moradores: [
      { id: 'm1', nome: 'Ana Silva', casa: 'Rua Brasil, 100', whats: '11999999991', tipo: 'proprietária' },
      { id: 'm2', nome: 'Bruno Souza', casa: 'Rua Chile, 20', whats: '11999999992', tipo: 'locatário' }
    ],
    encomendas: [],
    auditoria: [],
    configPublica: {}
  };
}

function service(state = baseState()) {
  let counter = 10;
  return new ResidentManagementService({
    associations: new FakeAssociations(state),
    now: () => new Date('2026-09-05T01:00:00.000Z'),
    idGenerator: () => 'm' + (++counter)
  });
}

test('normaliza telefone local e rejeita formatos inválidos', () => {
  assert.equal(normalizePhone('(11) 99999-9999'), '11999999999');
  assert.equal(normalizePhone('5511999999999'), '11999999999');
  assert.equal(normalizePhone(''), '');
  assert.throws(() => normalizePhone('1234'), /10 ou 11 dígitos/);
});

test('cadastro bloqueia duplicidade exata e exige confirmação para WhatsApp compartilhado', () => {
  const svc = service();
  assert.throws(
    () => svc.create('principal', { nome: 'Ana Silva', casa: 'Rua Brasil, 100', whats: '11988888888' }),
    error => error.statusCode === 409 && /mesmo nome e endereço/.test(error.message)
  );
  assert.throws(
    () => svc.create('principal', { nome: 'Carlos Lima', casa: 'Rua Peru, 30', whats: '11999999991' }),
    error => error.code === 'SHARED_PHONE'
  );
  const created = svc.create('principal', { nome: 'Carlos Lima', casa: 'Rua Peru, 30', whats: '11999999991', allowSharedPhone: true });
  assert.equal(created.resident.nome, 'Carlos Lima');
  assert.equal(svc.list('principal').summary.active, 3);
  assert.equal(svc.list('principal').summary.sharedPhones, 1);
});

test('desativação é reversível e remove morador da lista operacional ativa', () => {
  const svc = service();
  const result = svc.deactivate('principal', 'm1', 'Mudança de endereço', { name: 'Admin' });
  assert.equal(result.resident.ativo, false);
  let list = svc.list('principal');
  assert.equal(list.summary.active, 1);
  assert.equal(list.summary.inactive, 1);
  assert.equal(svc.associations.value.moradores.some(item => item.id === 'm1'), false);
  assert.equal(svc.associations.value.configPublica[ARCHIVE_KEY].some(item => item.id === 'm1'), true);

  svc.reactivate('principal', 'm1', { name: 'Admin' });
  list = svc.list('principal');
  assert.equal(list.summary.active, 2);
  assert.equal(list.summary.inactive, 0);
  assert.equal(svc.associations.value.moradores.some(item => item.id === 'm1'), true);
});

test('desativação é bloqueada quando existem encomendas pendentes', () => {
  const state = baseState();
  state.encomendas.push({ id: 'e1', codigo: 'PKG-1', moradorId: 'm1', status: 'pendente' });
  const svc = service(state);
  assert.throws(
    () => svc.deactivate('principal', 'm1', 'Mudança de morador', { name: 'Admin' }),
    error => error.code === 'PENDING_PACKAGES' && error.pendingPackages.length === 1
  );
  assert.equal(svc.list('principal').summary.active, 2);
});

test('importação sempre permite prévia e aplica inclusão/atualização sem conflito silencioso', () => {
  const svc = service();
  const rows = [
    { nome: 'Ana Silva', casa: 'Rua Brasil, 100', whats: '11977777777', tipo: 'proprietária' },
    { nome: 'Carla Mendes', casa: 'Rua México, 80', whats: '11966666666', tipo: 'locatária' }
  ];
  const preview = svc.prepareImport('principal', rows);
  assert.equal(preview.summary.update, 1);
  assert.equal(preview.summary.add, 1);
  assert.equal(preview.summary.conflicts, 0);
  const applied = svc.importRows('principal', rows, {}, { name: 'Admin' });
  assert.equal(applied.added, 1);
  assert.equal(applied.updated, 1);
  assert.equal(svc.list('principal').summary.active, 3);
});

test('importação interrompe aplicação quando há cadastro inativo ou conflito', () => {
  const svc = service();
  svc.deactivate('principal', 'm1', 'Mudança de morador', { name: 'Admin' });
  const rows = [{ nome: 'Ana Silva', casa: 'Rua Brasil, 100', whats: '11955555555' }];
  const preview = svc.prepareImport('principal', rows);
  assert.equal(preview.summary.conflicts, 1);
  assert.throws(() => svc.importRows('principal', rows), error => error.code === 'IMPORT_REVIEW_REQUIRED');
});

test('interface e servidor dedicados protegem a gestão por sessão administrativa', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'moradores.html'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'moradores-admin.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'scripts', 'resident-management-server.js'), 'utf8');
  assert.match(html, /Gestão de Moradores/);
  assert.match(html, /Importação em massa/);
  assert.match(html, /Duplicidades exatas/);
  assert.match(client, /\/api\/residents\/import\/preview/);
  assert.match(client, /SHARED_PHONE/);
  assert.match(server, /http:\/\/127\.0\.0\.1:3000\/api\/auth\/me/);
  assert.match(server, /payload\.user\.perfil !== 'admin'/);
  assert.match(server, /\/api\/residents\/health/);
});
