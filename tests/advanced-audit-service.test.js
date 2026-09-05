'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AdvancedAuditService, scrub } = require('../advanced-audit-service');
const { appendEvent } = require('../custody-chain');

function fixture(options = {}) {
  const pkg = {
    id: 'p1',
    codigo: 'AB123456789BR',
    moradorNome: 'Ana Teste'
  };
  appendEvent(pkg, {
    type: 'package_received',
    title: 'Encomenda recebida',
    occurredAt: '2026-09-05T10:00:00.000Z',
    recordedAt: '2026-09-05T10:00:00.000Z',
    actor: 'Porteiro José',
    actorRole: 'porteiro'
  });
  if (options.tamperPackage) pkg.cadeiaCustodia[0].title = 'Evento adulterado';
  if (options.missingPackageChain) delete pkg.cadeiaCustodia;

  const state = {
    encomendas: [pkg],
    auditoria: [{
      id: 'a1',
      data: '2026-09-05T09:00:00.000Z',
      acao: 'Cadastro atualizado',
      usuarioNome: 'Administrador',
      usuarioPerfil: 'admin',
      detalhes: {
        codigo: 'AB123456789BR',
        observacao: 'correção autorizada',
        pin: '654321',
        senha: 'segredo',
        telefone: '17999999999',
        fotoDocumento: 'data:image/png;base64,SEGREDO'
      }
    }]
  };
  const databaseStatus = {
    integrity: options.databaseIntegrity || 'ok',
    custody: { appendOnly: true }
  };
  const associations = {
    readState: () => state,
    database: () => ({ status: () => databaseStatus }),
    publicInfo: id => ({ id, nome: 'Associação Teste' })
  };
  const access = {
    listEvents: () => [{
      id: 7,
      occurredAt: '2026-09-05T11:00:00.000Z',
      type: 'login_failed',
      actorName: 'Supervisor Maria',
      targetName: 'Supervisor Maria',
      associationId: 'principal',
      ip: '127.0.0.1',
      detail: 'invalid_password'
    }]
  };
  const occurrenceIntegrity = options.occurrenceIntegrity || 'ok';
  const occurrence = {
    id: 'oc1',
    number: 'OC-2026-000001',
    packageCode: 'AB123456789BR',
    residentName: 'Ana Teste'
  };
  const occurrences = {
    list: () => ({ occurrences: [occurrence] }),
    get: () => ({
      events: [{
        id: 'ev1',
        occurredAt: '2026-09-05T12:00:00.000Z',
        type: 'occurrence_opened',
        title: 'Ocorrência aberta',
        description: 'Apuração iniciada',
        actor: { name: 'Porteiro João', role: 'porteiro' },
        hash: 'a'.repeat(64)
      }],
      integrity: { status: occurrenceIntegrity }
    })
  };
  return new AdvancedAuditService({
    associations,
    access,
    occurrences,
    now: () => new Date('2026-09-05T08:00:00.000Z')
  });
}

test('auditoria avançada consolida quatro fontes e calcula SHA-256 do resultado', () => {
  const report = fixture().build('principal', { mode: 'today' });
  assert.equal(report.association.id, 'principal');
  assert.deepEqual(report.summary, {
    total: 4,
    operational: 1,
    custody: 1,
    access: 1,
    occurrences: 1,
    securityAlerts: 1
  });
  assert.equal(report.integrity.overall, 'ok');
  assert.equal(report.integrity.packageChains.valid, 1);
  assert.equal(report.integrity.occurrenceChains.valid, 1);
  assert.match(report.reportHash, /^[a-f0-9]{64}$/);
});

test('filtros localizam responsável e isolam fonte e categoria', () => {
  const byActor = fixture().build('principal', { mode: 'today', q: 'supervisor maria' });
  assert.equal(byActor.summary.total, 1);
  assert.equal(byActor.events[0].source, 'access');

  const security = fixture().build('principal', { mode: 'today', source: 'access', category: 'security' });
  assert.equal(security.summary.total, 1);
  assert.equal(security.summary.securityAlerts, 1);
});

test('relatório elimina campos sensíveis dos detalhes operacionais', () => {
  const report = fixture().build('principal', { mode: 'today', source: 'operational' });
  const serialized = JSON.stringify(report.events);
  assert.doesNotMatch(serialized, /654321|segredo|17999999999|base64/i);
  assert.match(serialized, /correção autorizada/);

  assert.deepEqual(scrub({ nome: 'Ana', token: 'x', documento: 'y', nested: { password: 'z', valor: 2 } }), {
    nome: 'Ana', nested: { valor: 2 }
  });
});

test('integridade sinaliza adulteração e ausência de cadeia', () => {
  const invalid = fixture({ tamperPackage: true }).build('principal', { mode: 'today' });
  assert.equal(invalid.integrity.overall, 'error');
  assert.equal(invalid.integrity.packageChains.invalid, 1);

  const missing = fixture({ missingPackageChain: true }).build('principal', { mode: 'today' });
  assert.equal(missing.integrity.overall, 'warning');
  assert.equal(missing.integrity.packageChains.missing, 1);
});

test('painel avançado possui proteção, filtros, CSV, PDF e atalhos administrativos', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'auditoria-avancada.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'auditoria-avancada.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  const reports = fs.readFileSync(path.join(__dirname, '..', 'relatorios.html'), 'utf8');

  assert.match(html, /Relatórios e Auditoria Avançada/);
  assert.match(html, /A4 landscape/);
  assert.match(client, /\/api\/audit\/advanced/);
  assert.match(client, /downloadCsv/);
  assert.match(client, /window\.print/);
  assert.match(server, /requireRole\(req, \['admin', 'supervisor'\]\)/);
  assert.match(admin, /auditoria-avancada\.html/);
  assert.match(reports, /auditoria-avancada\.html/);
});
