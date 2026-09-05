'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { reconcileState } = require('../custody-chain');
const { PackageManagementService } = require('../package-management-service');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

const fixedNow = new Date('2026-09-05T15:00:00.000Z');

class FakeAssociations {
  constructor(state) { this.value = clone(state); }
  readState(id) { return { ...clone(this.value), exists: true, associacao: { id, nome: 'Associação Teste' } }; }
  writeState(id, state) {
    this.value = reconcileState({ ...clone(this.value), exists: true }, clone(state), { now: fixedNow });
    return this.readState(id);
  }
  publicInfo(id) { return { id, nome: 'Associação Teste' }; }
}

function baseState() {
  return {
    version: 10,
    updatedAt: '2026-09-05T12:00:00.000Z',
    moradores: [
      { id: 'm1', nome: 'Ana Silva', casa: 'Rua Brasil, 10', whats: '11999999991' },
      { id: 'm2', nome: 'Bruno Souza', casa: 'Rua Roma, 20', whats: '17999999992' }
    ],
    encomendas: [
      { id: 'p1', codigo: 'AB123456', status: 'pendente', moradorId: 'm1', moradorNome: 'Ana Silva', moradorCasa: 'Rua Brasil, 10', dataEntrada: '05/09/2026, 08:00:00', transportadora: 'Correios' },
      { id: 'p2', codigo: 'CD123456', status: 'retirado', moradorId: 'm2', moradorNome: 'Bruno Souza', moradorCasa: 'Rua Roma, 20', dataEntrada: '04/09/2026, 08:00:00', dataRetirada: '05/09/2026, 09:00:00' },
      { id: 'p3', codigo: 'EF123456', status: 'cancelado', moradorId: 'm1', moradorNome: 'Ana Silva', moradorCasa: 'Rua Brasil, 10', dataEntrada: '03/09/2026, 08:00:00', motivoCancelamento: 'Registro duplicado' }
    ],
    auditoria: [],
    configPublica: { packageAlertsPolicy: { attentionHours: 120, criticalHours: 168, timezoneOffsetMinutes: -180 } }
  };
}

function service(state = baseState()) {
  const associations = new FakeAssociations(state);
  return new PackageManagementService({ associations, now: () => new Date(fixedNow) });
}

const actor = { id: 'u1', name: 'Administrador', role: 'admin', ip: '127.0.0.1' };

test('lista e filtra o histórico sem expor imagens, assinatura ou PIN', () => {
  const state = baseState();
  state.encomendas[0].fotoEtiqueta = 'data:image/jpeg;base64,segredo';
  state.encomendas[0].pinRetirada = '123456';
  const svc = service(state);
  const result = svc.list('principal', { status: 'pendente', q: 'Ana', timezoneOffsetMinutes: -180 });
  assert.deepEqual(result.summary, { total: 3, pending: 1, withdrawn: 1, cancelled: 1, priority: 0, critical: 0, filtered: 1 });
  assert.equal(result.packages[0].id, 'p1');
  assert.equal(result.packages[0].hasLabelPhoto, true);
  assert.equal('fotoEtiqueta' in result.packages[0], false);
  assert.equal('pinRetirada' in result.packages[0], false);
  assert.equal(result.residents.length, 2);
});

test('corrige encomenda pendente com motivo, auditoria e cadeia de custódia', () => {
  const svc = service();
  const result = svc.update('principal', 'p1', {
    expectedVersion: 10,
    code: 'xy 987654',
    carrier: 'Loggi',
    residentId: 'm2',
    notes: 'Volume frágil',
    reason: 'Destinatário lido incorretamente'
  }, actor);
  assert.equal(result.package.code, 'XY987654');
  assert.equal(result.package.residentId, 'm2');
  assert.equal(result.package.custody.ok, true);
  assert.ok(result.package.timeline.some(item => item.type === 'recipient_corrected'));
  assert.ok(result.package.timeline.some(item => item.type === 'package_data_corrected'));
  assert.equal(svc.associations.value.auditoria[0].acao, 'Encomenda corrigida');
  assert.equal(svc.associations.value.auditoria[0].detalhes.motivo, 'Destinatário lido incorretamente');
});

test('bloqueia código pendente duplicado, versão antiga e alteração de retirada concluída', () => {
  const state = baseState();
  state.encomendas.push({ id: 'p4', codigo: 'ZZ123456', status: 'pendente', moradorId: 'm2', moradorNome: 'Bruno Souza', moradorCasa: 'Rua Roma, 20', dataEntrada: '05/09/2026, 09:00:00' });
  const svc = service(state);
  assert.throws(() => svc.update('principal', 'p1', { expectedVersion: 10, code: 'ZZ-123456', residentId: 'm1', reason: 'Correção do código duplicado' }, actor), error => error.code === 'DUPLICATE_OPEN_CODE');
  assert.throws(() => svc.update('principal', 'p1', { expectedVersion: 9, code: 'AA999999', residentId: 'm1', reason: 'Correção solicitada' }, actor), error => error.code === 'STATE_CHANGED');
  assert.throws(() => svc.update('principal', 'p2', { expectedVersion: 10, code: 'AA999999', residentId: 'm1', reason: 'Correção solicitada' }, actor), error => error.code === 'PACKAGE_NOT_PENDING');
});

test('cancelamento preserva registro e reabertura acrescenta eventos encadeados', () => {
  const svc = service();
  let result = svc.cancel('principal', 'p1', { expectedVersion: 10, reason: 'Cadastro realizado em duplicidade' }, actor);
  assert.equal(result.package.status, 'cancelado');
  assert.equal(result.package.cancellationReason, 'Cadastro realizado em duplicidade');
  assert.ok(result.package.timeline.some(item => item.type === 'package_cancelled'));
  result = svc.reopen('principal', 'p1', { expectedVersion: result.version, reason: 'Cancelamento efetuado por engano' }, actor);
  assert.equal(result.package.status, 'pendente');
  assert.equal(result.package.reopeningReason, 'Cancelamento efetuado por engano');
  assert.ok(result.package.timeline.some(item => item.type === 'package_reopened'));
  assert.equal(result.package.custody.ok, true);
  assert.equal(svc.associations.value.encomendas.length, 3);
});

test('interface e API da Gestão de Encomendas 2.0 estão protegidas e integradas', () => {
  const root = path.join(__dirname, '..');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'encomendas-admin.html'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'encomendas-admin.js'), 'utf8');
  const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(server, /\/api\/packages\/management/);
  assert.match(server, /packageManagement\.update/);
  assert.match(server, /requireRole\(req, \['admin', 'supervisor'\]\)/);
  assert.match(html, /Gestão de Encomendas 2\.0/);
  assert.match(html, /Corrigir encomenda pendente/);
  assert.match(client, /expectedVersion/);
  assert.match(client, /\/cancel/);
  assert.match(client, /\/reopen/);
  assert.match(admin, /encomendas-admin\.html/);
  assert.match(index, /Gestão de Encomendas 2\.0/);
});
