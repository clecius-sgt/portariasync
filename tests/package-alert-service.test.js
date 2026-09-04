'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AssociationManager } = require('../association-manager');
const {
  PackageAlertService,
  normalizePolicy,
  levelForAge,
  dueStage,
  SUCCESS_EVENT,
  FAILURE_EVENT
} = require('../package-alert-service');

function makeState(entry, overrides = {}) {
  return {
    version: Date.now(),
    updatedAt: new Date().toISOString(),
    moradores: [{ id:'m1', nome:'Ana Teste', casa:'Rua A, 10', whats:'17999999999' }],
    encomendas: [{
      id:'p1', codigo:'TESTE123456', transportadora:'Correios', status:'pendente',
      moradorId:'m1', moradorNome:'Ana Teste', moradorCasa:'Rua A, 10', moradorWhats:'17999999999',
      dataEntrada:entry, ...overrides
    }],
    retirantesRelacionados: [], auditoria: [], detalhesRetirada:{}, memoriaRemetentes:{},
    configPublica:{
      packageAlertsPolicy:{
        enabled:true, reminder1Hours:24, reminder2Hours:72, attentionHours:120, criticalHours:168,
        minGapHours:20, retryHours:6, sendWindowStart:0, sendWindowEnd:24, timezoneOffsetMinutes:0, adminWhatsApp:''
      }
    }, resetEncomendasAt:null
  };
}

function tempManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portariasync-alerts-'));
  return new AssociationManager({ dataDir:dir });
}

test('política normaliza marcos em ordem crescente e classifica níveis', () => {
  const p = normalizePolicy({ reminder1Hours:24, reminder2Hours:20, attentionHours:20, criticalHours:20 });
  assert.equal(p.reminder1Hours, 24);
  assert.ok(p.reminder2Hours > p.reminder1Hours);
  assert.ok(p.attentionHours > p.reminder2Hours);
  assert.ok(p.criticalHours > p.attentionHours);
  const normal = normalizePolicy({ reminder2Hours:72, attentionHours:120, criticalHours:168 });
  assert.equal(levelForAge(20, normal), 'normal');
  assert.equal(levelForAge(80, normal), 'attention');
  assert.equal(levelForAge(130, normal), 'priority');
  assert.equal(levelForAge(180, normal), 'critical');
});

test('encomenda pendente entra no primeiro marco sem enviar fora da janela ou quando suspensa', () => {
  const now = new Date('2026-09-04T10:00:00Z');
  const state = makeState('2026-09-03T04:00:00Z');
  assert.equal(dueStage(state.encomendas[0], state, now).id, 'resident-reminder-1');
  state.configPublica.packageAlertsSuspended = { p1:{ suspended:true, reason:'teste' } };
  assert.equal(dueStage(state.encomendas[0], state, now), null);
  delete state.configPublica.packageAlertsSuspended;
  state.configPublica.packageAlertsPolicy.sendWindowStart = 12;
  state.configPublica.packageAlertsPolicy.sendWindowEnd = 20;
  assert.equal(dueStage(state.encomendas[0], state, now), null);
});

test('serviço envia o primeiro lembrete uma única vez e registra na Cadeia de Custódia', async () => {
  const manager = tempManager();
  const now = new Date('2026-09-04T10:00:00Z');
  manager.writeState('principal', makeState('2026-09-03T04:00:00Z'));
  let reminders = 0;
  const whatsapp = {
    async sendReminder(data) { reminders++; assert.equal(data.numero, '17999999999'); return {ok:true}; },
    async sendText() { throw new Error('não deveria escalar'); }
  };
  const service = new PackageAlertService({ associations:manager, whatsapp, now:()=>new Date(now), intervalMs:60000 });
  const first = await service.runAssociation('principal');
  assert.equal(first.sent, 1);
  assert.equal(reminders, 1);
  const stored = manager.readState('principal');
  const events = stored.encomendas[0].cadeiaCustodia.filter(e => e.type === SUCCESS_EVENT);
  assert.equal(events.length, 1);
  assert.equal(events[0].metadata.alertStage, 'resident-reminder-1');
  assert.equal(stored.encomendas[0].status, 'pendente');

  const second = await service.runAssociation('principal');
  assert.equal(second.sent, 0);
  assert.equal(reminders, 1);
  manager.closeAll();
});

test('falha de WhatsApp preserva status, registra tentativa e agenda retry sem duplicar imediatamente', async () => {
  const manager = tempManager();
  const now = new Date('2026-09-04T10:00:00Z');
  manager.writeState('principal', makeState('2026-09-03T04:00:00Z'));
  let attempts = 0;
  const whatsapp = {
    async sendReminder() { attempts++; throw new Error('offline'); },
    async sendText() {}
  };
  const service = new PackageAlertService({ associations:manager, whatsapp, now:()=>new Date(now), intervalMs:60000 });
  const first = await service.runAssociation('principal');
  assert.equal(first.failed, 1);
  assert.equal(attempts, 1);
  let stored = manager.readState('principal');
  assert.equal(stored.encomendas[0].status, 'pendente');
  assert.ok(stored.encomendas[0].cadeiaCustodia.some(e => e.type === FAILURE_EVENT && e.metadata.alertStage === 'resident-reminder-1'));

  const second = await service.runAssociation('principal');
  assert.equal(second.sent, 0);
  assert.equal(second.failed, 0);
  assert.equal(attempts, 1);
  manager.closeAll();
});

test('escalonamento administrativo sem telefone vira alerta de painel sem mensagem externa', async () => {
  const manager = tempManager();
  const now = new Date('2026-09-10T10:00:00Z');
  const state = makeState('2026-09-03T04:00:00Z');
  manager.writeState('principal', state);
  let resident = 0;
  let admin = 0;
  const whatsapp = {
    async sendReminder() { resident++; return {ok:true}; },
    async sendText() { admin++; return {ok:true}; }
  };
  const service = new PackageAlertService({ associations:manager, whatsapp, now:()=>new Date(now), intervalMs:60000 });

  await service.runAssociation('principal');
  const pkg1 = manager.readState('principal').encomendas[0];
  assert.ok(pkg1.cadeiaCustodia.some(e => e.type === SUCCESS_EVENT && e.metadata.alertStage === 'resident-reminder-1'));

  const later1 = new Date(now.getTime() + 21 * 3600000);
  service.now = () => new Date(later1);
  await service.runAssociation('principal');
  const later2 = new Date(later1.getTime() + 21 * 3600000);
  service.now = () => new Date(later2);
  await service.runAssociation('principal');
  const stored = manager.readState('principal').encomendas[0];
  assert.ok(stored.cadeiaCustodia.some(e => e.type === SUCCESS_EVENT && e.metadata.alertStage === 'admin-attention'));
  assert.equal(admin, 0);
  assert.equal(resident, 2);
  manager.closeAll();
});

test('daemon e painel dos alertas existem e não dependem de serviço pago adicional', () => {
  const root = path.join(__dirname, '..');
  const daemon = fs.readFileSync(path.join(root, 'scripts', 'package-alert-daemon.js'), 'utf8');
  const page = fs.readFileSync(path.join(root, 'alertas.html'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'package-alerts-client.js'), 'utf8');
  assert.match(daemon, /PackageAlertService/);
  assert.match(daemon, /PACKAGE_ALERTS_INTERVAL_MINUTES/);
  assert.match(page, /Alertas inteligentes de permanência/);
  assert.match(page, /portariasync-alerts/);
  assert.match(client, /PRIORIDADE/);
  assert.match(client, /CRÍTICO/);
});
