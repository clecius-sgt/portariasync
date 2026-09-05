'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Dashboard = require('../operational-dashboard');

const root = path.join(__dirname, '..');

function state() {
  return {
    moradores: [
      { id: 'm1', nome: 'Maria Silva', casa: 'Rua Brasil, 10' },
      { id: 'm2', nome: 'João Souza', casa: 'Rua Roma, 20' }
    ],
    encomendas: [
      { id: 'p1', codigo: 'AA1', status: 'pendente', moradorId: 'm1', dataEntrada: '05/09/2026, 08:00:00', transportadora: 'Correios' },
      { id: 'p2', codigo: 'AA2', status: 'pendente', moradorId: 'm2', dataEntrada: '29/08/2026, 12:00:00', transportadora: 'Loggi' },
      { id: 'p3', codigo: 'AA3', status: 'retirado', moradorId: 'm1', dataEntrada: '05/09/2026, 09:00:00', dataRetirada: '05/09/2026, 11:30:00' },
      { id: 'p4', codigo: 'AA4', status: 'cancelado', moradorId: 'm1', dataEntrada: '05/09/2026, 10:00:00' }
    ],
    configPublica: {
      packageAlertsPolicy: { reminder2Hours: 72, attentionHours: 120, criticalHours: 168, timezoneOffsetMinutes: -180 }
    }
  };
}

test('interpreta datas brasileiras como horário local da associação', () => {
  const date = Dashboard.parseBusinessDate('05/09/2026, 08:30:00', -180);
  assert.equal(date.toISOString(), '2026-09-05T11:30:00.000Z');
  assert.deepEqual(Dashboard.localParts(date, -180), { day: '2026-09-05', hour: 8 });
});

test('resume entradas, retiradas e fila operacional do dia', () => {
  const result = Dashboard.build(state(), {
    now: '2026-09-05T15:00:00.000Z',
    timezoneOffsetMinutes: -180,
    association: { id: 'principal', nome: 'Associação de Moradores' },
    database: { ready: true },
    whatsapp: { configured: true },
    paddleocr: { installed: true, ready: true },
    occurrences: { opened: 1, inProgress: 2, critical: 0 }
  });
  assert.equal(result.summary.receivedToday, 3);
  assert.equal(result.summary.withdrawnToday, 1);
  assert.equal(result.summary.pending, 2);
  assert.equal(result.summary.critical, 1);
  assert.equal(result.summary.priority, 1);
  assert.equal(result.summary.openOccurrences, 3);
  assert.equal(result.queue[0].id, 'p2');
  assert.equal(result.queue[0].level, 'critical');
  assert.equal(result.queue[1].resident, 'Maria Silva');
  assert.equal(result.hourly[8].received, 1);
  assert.equal(result.hourly[11].withdrawn, 1);
});

test('gera alertas somente quando há condição que exige atenção', () => {
  const result = Dashboard.build(state(), {
    now: '2026-09-05T15:00:00.000Z',
    timezoneOffsetMinutes: -180,
    database: { ready: true },
    whatsapp: { configured: false },
    paddleocr: { installed: false, ready: false },
    occurrences: { opened: 0, inProgress: 0, critical: 2 }
  });
  assert.ok(result.alerts.some(item => item.title.includes('situação crítica')));
  assert.ok(result.alerts.some(item => item.title.includes('ocorrência')));
  assert.ok(result.alerts.some(item => item.title === 'WhatsApp indisponível'));
  assert.ok(result.alerts.some(item => item.title === 'Leitor OCR não instalado'));
});

test('API e painel dedicados protegem e atualizam o dashboard operacional', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'dashboard-operacional.html'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'dashboard-operacional.js'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(server, /\/api\/dashboard\/operational/);
  assert.match(server, /requireRole\(req, \['admin', 'porteiro', 'supervisor'\]\)/);
  assert.match(server, /OperationalDashboard\.build/);
  assert.match(html, /Dashboard Operacional/);
  assert.match(html, /Fila de encomendas/);
  assert.match(html, /Movimento de hoje por hora/);
  assert.match(client, /\/api\/dashboard\/operational\?tzOffset=/);
  assert.match(client, /setInterval[\s\S]*30000/);
  assert.match(index, /Abrir Dashboard Operacional/);
});
