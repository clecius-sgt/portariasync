'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { StructuredDatabase, SCHEMA_VERSION } = require('../structured-database');

function state() {
  return {
    version: 1,
    updatedAt: '2026-09-03T20:00:00.000Z',
    moradores: [{ id:'m1', nome:'Ana', casa:'Rua A, 1', whats:'17999998888' }],
    encomendas: [{
      id:'p1', codigo:'ABC123456', status:'pendente', moradorId:'m1', moradorNome:'Ana', moradorCasa:'Rua A, 1',
      dataEntrada:'03/09/2026 17:00'
    }],
    retirantesRelacionados: [], auditoria: [], detalhesRetirada: {}, memoriaRemetentes: {}, configPublica: {}, resetEncomendasAt:null
  };
}

test('schema 2 mantém eventos em tabela append-only com bloqueio físico de UPDATE e DELETE', () => {
  const db = new StructuredDatabase({ file:':memory:' });
  db.writeState(state());
  assert.equal(SCHEMA_VERSION, 2);
  assert.ok(db.status().counts.custodyEvents >= 2);
  const row = db.db.prepare('SELECT id, event_hash FROM custody_events ORDER BY sequence LIMIT 1').get();
  assert.ok(row?.id);
  assert.throws(
    () => db.db.prepare('UPDATE custody_events SET event_hash = ? WHERE id = ?').run('f'.repeat(64), row.id),
    /append-only/
  );
  assert.throws(
    () => db.db.prepare('DELETE FROM custody_events WHERE id = ?').run(row.id),
    /append-only/
  );
  assert.equal(db.db.prepare('SELECT event_hash FROM custody_events WHERE id = ?').get(row.id).event_hash, row.event_hash);
  db.close();
});

test('eventos sobrevivem à remoção do registro operacional da encomenda', () => {
  const db = new StructuredDatabase({ file:':memory:' });
  db.writeState(state());
  const before = db.status().counts.custodyEvents;
  const empty = { ...state(), encomendas: [], version:2 };
  db.writeState(empty);
  assert.equal(db.readState().encomendas.length, 0);
  assert.equal(db.status().counts.custodyEvents, before);
  db.close();
});
