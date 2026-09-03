'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Reports = require('../managerial-reports');

test('gera KPIs gerenciais sem duplicar moradores', () => {
  const state = {
    moradores: [
      { id: 'm1', nome: 'Ana', casa: 'Rua A, 10' },
      { id: 'm2', nome: 'Bruno', casa: 'Rua B, 20' }
    ],
    encomendas: [
      { id: 'e1', moradorId: 'm1', transportadora: 'Correios', codigo: 'AA1', status: 'retirado', dataEntrada: '2026-09-01T10:00:00-03:00', dataRetirada: '2026-09-01T16:00:00-03:00' },
      { id: 'e2', moradorId: 'm1', transportadora: 'Correios', codigo: 'AA2', status: 'pendente', dataEntrada: '2026-09-02T10:00:00-03:00' },
      { id: 'e3', moradorId: 'm2', transportadora: 'Mercado Livre', codigo: 'BB1', status: 'retirado', dataEntrada: '2026-08-20T10:00:00-03:00', dataRetirada: '2026-09-02T10:00:00-03:00' }
    ],
    configPublica: { metricasOcr: { events: [
      { at: '2026-09-02T11:00:00-03:00', addressResolved: true, fallbackUsed: false, elapsedMs: 1200 },
      { at: '2026-09-02T12:00:00-03:00', addressResolved: false, fallbackUsed: true, failed: true, elapsedMs: 2200 }
    ] } }
  };

  const report = Reports.build(state, { mode: '30' }, new Date('2026-09-03T12:00:00-03:00'));
  assert.equal(report.totals.residents, 2);
  assert.equal(report.totals.received, 3);
  assert.equal(report.totals.withdrawn, 2);
  assert.equal(report.totals.pending, 1);
  assert.equal(report.totals.pendingOver48h, 0);
  assert.equal(report.totals.sameDayRate, 50);
  assert.equal(report.ocr.total, 2);
  assert.equal(report.ocr.addressRate, 50);
  assert.equal(report.ocr.fallbackRate, 50);
  assert.equal(report.ocr.failureRate, 50);
  assert.equal(report.carriers[0].label, 'Correios');
  assert.equal(report.carriers[0].count, 2);
  assert.equal(report.residents[0].label, 'Ana');
  assert.equal(report.residents[0].count, 2);
});

test('classifica envelhecimento das pendências e ordena as mais antigas', () => {
  const state = {
    moradores: [{ id: 'm1', nome: 'Ana', casa: 'Rua A, 10' }],
    encomendas: [
      { id: 'a', moradorId: 'm1', status: 'pendente', dataEntrada: '2026-09-03T10:00:00-03:00' },
      { id: 'b', moradorId: 'm1', status: 'pendente', dataEntrada: '2026-08-25T10:00:00-03:00' },
      { id: 'c', moradorId: 'm1', status: 'pendente' }
    ]
  };
  const report = Reports.build(state, { mode: '30' }, new Date('2026-09-03T12:00:00-03:00'));
  assert.equal(report.totals.pending, 3);
  assert.equal(report.totals.pendingOver48h, 1);
  assert.equal(report.pendingRows[0].id, 'b');
  const buckets = Object.fromEntries(report.pendingAging.map(item => [item.label, item.count]));
  assert.equal(buckets['Até 24h'], 1);
  assert.equal(buckets['Mais de 7 dias'], 1);
  assert.equal(buckets['Sem data'], 1);
});

test('período personalizado filtra entradas e retiradas por suas próprias datas', () => {
  const state = {
    encomendas: [
      { id: 'e1', status: 'retirado', dataEntrada: '2026-08-31T10:00:00-03:00', dataRetirada: '2026-09-02T10:00:00-03:00' },
      { id: 'e2', status: 'pendente', dataEntrada: '2026-09-02T10:00:00-03:00' }
    ]
  };
  const report = Reports.build(state, { mode: 'custom', start: '2026-09-01', end: '2026-09-03' }, new Date('2026-09-03T12:00:00-03:00'));
  assert.equal(report.totals.received, 1);
  assert.equal(report.totals.withdrawn, 1);
  assert.equal(report.totals.pending, 1);
});

test('interpreta data brasileira e status de retirada pela data', () => {
  const parsed = Reports.parseDate('03/09/2026 14:30');
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 8);
  assert.equal(parsed.getDate(), 3);
  assert.equal(Reports.statusOf({ status: 'pendente', dataRetirada: '03/09/2026 14:30' }), 'retirado');
});
