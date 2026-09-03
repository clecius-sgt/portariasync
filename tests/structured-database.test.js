'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StructuredDatabase, SCHEMA_VERSION } = require('../structured-database');

function sampleState() {
  return {
    version: 123456,
    updatedAt: '2026-09-03T20:00:00.000Z',
    moradores: [
      { id: 'm1', nome: 'Morador Um', casa: 'Rua Exemplo, 10', whats: '11999990001' },
      { id: 'm2', nome: 'Morador Dois', casa: 'Rua Exemplo, 12', whats: '11999990002' }
    ],
    encomendas: [
      {
        id: 'enc1', codigo: 'TESTE123456', transportadora: 'Transportadora', status: 'pendente',
        moradorId: 'm1', moradorNome: 'Morador Um', moradorCasa: 'Rua Exemplo, 10',
        moradorWhats: '11999990001', pinRetirada: '483217', pinRetiradaEnviado: true, dataEntrada: '03/09/2026 17:00'
      }
    ],
    retirantesRelacionados: [
      { id: 'r1', moradorId: 'm1', nome: 'Retirante Teste', rg: '123456789' }
    ],
    auditoria: [
      { acao: 'Encomenda registrada', data: '03/09/2026 17:00', usuario: 'Administrador', encomendaId: 'enc1' }
    ],
    detalhesRetirada: { enc1: { observacao: 'teste' } },
    memoriaRemetentes: { loja: { nome: 'Loja Exemplo' } },
    configPublica: { diasAlertaRetirada: 3, recurso: { ativo: true } },
    resetEncomendasAt: null
  };
}

test('SQLite estruturado preserva estado completo e campos críticos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portariasync-db-'));
  const file = path.join(dir, 'portariasync.sqlite');
  const db = new StructuredDatabase({ file });
  const source = sampleState();

  db.writeState(source);
  const restored = db.readState();
  const status = db.status();

  assert.equal(restored.storage, 'sqlite');
  assert.equal(restored.databaseSchema, SCHEMA_VERSION);
  assert.equal(restored.moradores.length, 2);
  assert.equal(restored.encomendas.length, 1);
  assert.equal(restored.encomendas[0].pinRetirada, '483217');
  assert.equal(restored.encomendas[0].pinRetiradaEnviado, true);
  assert.equal(restored.retirantesRelacionados[0].rg, '123456789');
  assert.equal(restored.configPublica.recurso.ativo, true);
  assert.equal(status.integrity, 'ok');
  assert.equal(status.counts.residents, 2);
  assert.equal(status.counts.packages, 1);
  assert.equal(status.counts.audit, 1);
  db.close();
});

test('migração inicial importa app-state.json somente quando banco está vazio', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portariasync-migrate-'));
  const sourceFile = path.join(dir, 'app-state.json');
  const dbFile = path.join(dir, 'portariasync.sqlite');
  fs.writeFileSync(sourceFile, JSON.stringify(sampleState()));

  const db = new StructuredDatabase({ file: dbFile });
  const first = db.initializeFromJsonMirror(sourceFile);
  const second = db.initializeFromJsonMirror(sourceFile);

  assert.equal(first.migrated, true);
  assert.equal(second.migrated, false);
  assert.equal(second.reason, 'database-already-initialized');
  assert.equal(db.readState().moradores[0].id, 'm1');
  assert.equal(db.status().exists, true);
  db.close();
});

test('schema cria índices para consultas operacionais', () => {
  const db = new StructuredDatabase({ file: ':memory:' });
  const indexes = db.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => row.name);
  assert.ok(indexes.includes('idx_residents_name'));
  assert.ok(indexes.includes('idx_residents_house'));
  assert.ok(indexes.includes('idx_packages_code'));
  assert.ok(indexes.includes('idx_packages_status'));
  assert.ok(indexes.includes('idx_packages_resident'));
  db.close();
});
