'use strict';

const { appendEvent } = require('./custody-chain');

const DEFAULT_POLICY = Object.freeze({
  enabled: true,
  reminder1Hours: 24,
  reminder2Hours: 72,
  attentionHours: 120,
  criticalHours: 168,
  minGapHours: 20,
  retryHours: 6,
  sendWindowStart: 8,
  sendWindowEnd: 20,
  timezoneOffsetMinutes: -180,
  adminWhatsApp: ''
});

const RUNTIME_TABLE = 'package_alert_runtime';
const SUCCESS_EVENT = 'automatic_package_alert';
const FAILURE_EVENT = 'automatic_package_alert_failed';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function num(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizePolicy(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const reminder1Hours = num(source.reminder1Hours, DEFAULT_POLICY.reminder1Hours, 1, 24 * 30);
  const reminder2Hours = Math.max(reminder1Hours + 1, num(source.reminder2Hours, DEFAULT_POLICY.reminder2Hours, 2, 24 * 45));
  const attentionHours = Math.max(reminder2Hours + 1, num(source.attentionHours, DEFAULT_POLICY.attentionHours, 3, 24 * 60));
  const criticalHours = Math.max(attentionHours + 1, num(source.criticalHours, DEFAULT_POLICY.criticalHours, 4, 24 * 90));
  let sendWindowStart = num(source.sendWindowStart, DEFAULT_POLICY.sendWindowStart, 0, 23);
  let sendWindowEnd = num(source.sendWindowEnd, DEFAULT_POLICY.sendWindowEnd, 1, 24);
  if (sendWindowEnd <= sendWindowStart) {
    sendWindowStart = DEFAULT_POLICY.sendWindowStart;
    sendWindowEnd = DEFAULT_POLICY.sendWindowEnd;
  }
  return {
    enabled: source.enabled !== false,
    reminder1Hours,
    reminder2Hours,
    attentionHours,
    criticalHours,
    minGapHours: num(source.minGapHours, DEFAULT_POLICY.minGapHours, 1, 24 * 7),
    retryHours: num(source.retryHours, DEFAULT_POLICY.retryHours, 1, 24 * 7),
    sendWindowStart,
    sendWindowEnd,
    timezoneOffsetMinutes: num(source.timezoneOffsetMinutes, DEFAULT_POLICY.timezoneOffsetMinutes, -720, 840),
    adminWhatsApp: String(source.adminWhatsApp || '').replace(/\D/g, '').slice(0, 20)
  };
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(value.getTime());
  const direct = new Date(value);
  if (Number.isFinite(direct.getTime())) return direct;
  const match = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;
  const [, d, m, y, hh = '0', mm = '0', ss = '0'] = match;
  const parsed = new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function packageAgeHours(pkg, now = new Date()) {
  const entry = parseDate(pkg?.dataEntrada || pkg?.entryAt || pkg?.createdAt);
  if (!entry) return 0;
  return Math.max(0, (now.getTime() - entry.getTime()) / 3600000);
}

function stages(policyInput) {
  const policy = normalizePolicy(policyInput);
  return [
    { id: 'resident-reminder-1', thresholdHours: policy.reminder1Hours, audience: 'resident', level: 'normal', label: '1º lembrete automático' },
    { id: 'resident-reminder-2', thresholdHours: policy.reminder2Hours, audience: 'resident', level: 'attention', label: '2º lembrete automático' },
    { id: 'admin-attention', thresholdHours: policy.attentionHours, audience: 'admin', level: 'priority', label: 'Escalonamento para administração' },
    { id: 'admin-critical', thresholdHours: policy.criticalHours, audience: 'admin', level: 'critical', label: 'Alerta crítico para administração' }
  ];
}

function levelForAge(ageHours, policyInput) {
  const policy = normalizePolicy(policyInput);
  if (ageHours >= policy.criticalHours) return 'critical';
  if (ageHours >= policy.attentionHours) return 'priority';
  if (ageHours >= policy.reminder2Hours) return 'attention';
  return 'normal';
}

function localHour(date, offsetMinutes) {
  const shifted = new Date(date.getTime() + Number(offsetMinutes || 0) * 60000);
  return shifted.getUTCHours() + shifted.getUTCMinutes() / 60;
}

function withinSendWindow(now, policyInput) {
  const policy = normalizePolicy(policyInput);
  const hour = localHour(now, policy.timezoneOffsetMinutes);
  return hour >= policy.sendWindowStart && hour < policy.sendWindowEnd;
}

function nextWindowAt(date, policyInput) {
  const policy = normalizePolicy(policyInput);
  const shifted = new Date(date.getTime() + policy.timezoneOffsetMinutes * 60000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  const hour = shifted.getUTCHours() + shifted.getUTCMinutes() / 60;
  let targetDay = day;
  if (hour >= policy.sendWindowEnd) targetDay += 1;
  const localTarget = Date.UTC(year, month, targetDay, policy.sendWindowStart, 0, 0, 0);
  return new Date(localTarget - policy.timezoneOffsetMinutes * 60000);
}

function eventStage(event) {
  return String(event?.metadata?.alertStage || event?.metadata?.stage || '');
}

function sentStages(pkg) {
  const out = new Set();
  for (const event of Array.isArray(pkg?.cadeiaCustodia) ? pkg.cadeiaCustodia : []) {
    if (event?.type !== SUCCESS_EVENT) continue;
    const stage = eventStage(event);
    if (stage) out.add(stage);
  }
  return out;
}

function alertEvents(pkg) {
  return (Array.isArray(pkg?.cadeiaCustodia) ? pkg.cadeiaCustodia : [])
    .filter(event => event?.type === SUCCESS_EVENT || event?.type === FAILURE_EVENT);
}

function lastSuccessfulAction(pkg) {
  const events = alertEvents(pkg).filter(event => event?.type === SUCCESS_EVENT);
  const last = events.at(-1);
  return last ? parseDate(last.occurredAt || last.recordedAt) : null;
}

function suspensionMap(state) {
  const value = state?.configPublica?.packageAlertsSuspended;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function packageSuspended(state, packageId) {
  const record = suspensionMap(state)[String(packageId || '')];
  return record?.suspended === true;
}

function policyFromState(state) {
  return normalizePolicy(state?.configPublica?.packageAlertsPolicy || {});
}

function nextActionAt(pkg, state, now = new Date()) {
  const policy = policyFromState(state);
  if (!policy.enabled || pkg?.status !== 'pendente' || packageSuspended(state, pkg?.id)) return null;
  const entry = parseDate(pkg?.dataEntrada || pkg?.entryAt || pkg?.createdAt);
  if (!entry) return null;
  const sent = sentStages(pkg);
  const def = stages(policy).find(stage => !sent.has(stage.id));
  if (!def) return null;
  let target = new Date(entry.getTime() + def.thresholdHours * 3600000);
  const last = lastSuccessfulAction(pkg);
  if (last && (def.audience === 'resident' || (def.audience === 'admin' && policy.adminWhatsApp))) {
    const gap = new Date(last.getTime() + policy.minGapHours * 3600000);
    if (gap > target) target = gap;
  }
  if (!withinSendWindow(target, policy)) target = nextWindowAt(target, policy);
  if (target < now && withinSendWindow(now, policy)) return new Date(now.getTime());
  if (target < now) return nextWindowAt(now, policy);
  return target;
}

function dueStage(pkg, state, now = new Date()) {
  const policy = policyFromState(state);
  if (!policy.enabled || pkg?.status !== 'pendente' || packageSuspended(state, pkg?.id)) return null;
  if (!withinSendWindow(now, policy)) return null;
  const ageHours = packageAgeHours(pkg, now);
  const sent = sentStages(pkg);
  const def = stages(policy).find(stage => ageHours >= stage.thresholdHours && !sent.has(stage.id));
  if (!def) return null;
  const last = lastSuccessfulAction(pkg);
  const external = def.audience === 'resident' || (def.audience === 'admin' && !!policy.adminWhatsApp);
  if (external && last && now.getTime() - last.getTime() < policy.minGapHours * 3600000) return null;
  return { ...def, ageHours, policy };
}

function ensureRuntimeTable(database) {
  const db = database?.db;
  if (!db) throw new Error('Banco SQLite indisponível para o controle dos alertas.');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${RUNTIME_TABLE} (
      package_id TEXT PRIMARY KEY,
      stage TEXT,
      claim_until TEXT,
      sent_at TEXT,
      retry_after TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_package_alert_retry ON ${RUNTIME_TABLE}(retry_after);
  `);
}

function runtimeState(database, packageId) {
  ensureRuntimeTable(database);
  return database.db.prepare(`SELECT * FROM ${RUNTIME_TABLE} WHERE package_id = ?`).get(String(packageId || '')) || null;
}

function writeRuntime(database, packageId, patch = {}) {
  ensureRuntimeTable(database);
  const current = runtimeState(database, packageId) || {};
  const next = {
    package_id: String(packageId || ''),
    stage: patch.stage !== undefined ? patch.stage : current.stage || null,
    claim_until: patch.claim_until !== undefined ? patch.claim_until : current.claim_until || null,
    sent_at: patch.sent_at !== undefined ? patch.sent_at : current.sent_at || null,
    retry_after: patch.retry_after !== undefined ? patch.retry_after : current.retry_after || null,
    attempts: patch.attempts !== undefined ? Number(patch.attempts || 0) : Number(current.attempts || 0),
    last_error: patch.last_error !== undefined ? patch.last_error : current.last_error || null,
    updated_at: new Date().toISOString()
  };
  database.db.prepare(`
    INSERT INTO ${RUNTIME_TABLE}(package_id, stage, claim_until, sent_at, retry_after, attempts, last_error, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(package_id) DO UPDATE SET
      stage=excluded.stage, claim_until=excluded.claim_until, sent_at=excluded.sent_at,
      retry_after=excluded.retry_after, attempts=excluded.attempts, last_error=excluded.last_error,
      updated_at=excluded.updated_at
  `).run(next.package_id, next.stage, next.claim_until, next.sent_at, next.retry_after, next.attempts, next.last_error, next.updated_at);
  return next;
}

function clearRuntime(database, packageId) {
  ensureRuntimeTable(database);
  database.db.prepare(`DELETE FROM ${RUNTIME_TABLE} WHERE package_id = ?`).run(String(packageId || ''));
}

function runtimeBlocks(runtime, stageId, now) {
  if (!runtime) return false;
  const retry = parseDate(runtime.retry_after);
  if (retry && retry > now) return true;
  const claim = parseDate(runtime.claim_until);
  if (runtime.stage === stageId && claim && claim > now) return true;
  return false;
}

function safeError(error) {
  return String(error?.message || error || 'Falha não identificada').slice(0, 240);
}

class PackageAlertService {
  constructor(options = {}) {
    this.associations = options.associations;
    this.whatsapp = options.whatsapp;
    this.intervalMs = Math.max(60000, Number(options.intervalMs || 15 * 60 * 1000));
    this.startupDelayMs = Math.max(1000, Number(options.startupDelayMs || 5000));
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.timer = null;
    this.startTimer = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastError = null;
    this.lastSummary = null;
  }

  async recordEvent(associationId, packageId, spec) {
    const state = this.associations.readState(associationId);
    const pkg = (state.encomendas || []).find(item => String(item?.id || '') === String(packageId || ''));
    if (!pkg) return false;
    appendEvent(pkg, spec);
    const database = this.associations.database(associationId);
    database.persistCustodyEvents([pkg]);
    this.associations.writeMirror(associationId, state);
    return true;
  }

  async recoverDelivered(associationId, pkg, runtime) {
    if (!runtime?.sent_at || !runtime?.stage) return false;
    if (sentStages(pkg).has(runtime.stage)) {
      clearRuntime(this.associations.database(associationId), pkg.id);
      return true;
    }
    const stage = stages(policyFromState(this.associations.readState(associationId))).find(item => item.id === runtime.stage);
    await this.recordEvent(associationId, pkg.id, {
      type: SUCCESS_EVENT,
      title: stage?.label || 'Alerta automático registrado',
      description: 'Entrega confirmada pelo mecanismo de recuperação do PortalSync após reinício do serviço.',
      occurredAt: runtime.sent_at,
      actor: 'PortalSync', actorRole: 'sistema', source: 'alertas-inteligentes',
      metadata: { alertStage: runtime.stage, recovered: true, audience: stage?.audience || '' }
    });
    clearRuntime(this.associations.database(associationId), pkg.id);
    return true;
  }

  async deliver(associationId, pkg, due, now) {
    const database = this.associations.database(associationId);
    const runtime = runtimeState(database, pkg.id);
    if (runtime?.sent_at && runtime?.stage) await this.recoverDelivered(associationId, pkg, runtime);
    const latestRuntime = runtimeState(database, pkg.id);
    if (runtimeBlocks(latestRuntime, due.id, now)) return { skipped: true, reason: 'locked-or-retry' };

    const attempts = Number(latestRuntime?.attempts || 0) + 1;
    writeRuntime(database, pkg.id, {
      stage: due.id,
      claim_until: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      sent_at: null,
      retry_after: null,
      attempts,
      last_error: null
    });

    let delivery = 'painel';
    try {
      const days = Math.max(1, Math.floor(due.ageHours / 24));
      if (due.audience === 'resident') {
        if (!String(pkg.moradorWhats || '').replace(/\D/g, '')) throw new Error('Morador sem número de WhatsApp cadastrado.');
        await this.whatsapp.sendReminder({
          numero: pkg.moradorWhats,
          nome: pkg.moradorNome,
          codigo: pkg.codigo,
          transportadora: pkg.transportadora,
          dias: days,
          casa: pkg.moradorCasa
        });
        delivery = 'WhatsApp do morador';
      } else if (due.policy.adminWhatsApp) {
        await this.whatsapp.sendText(
          due.policy.adminWhatsApp,
          `PortalSync - ${due.label}\nEncomenda: ${pkg.codigo || '-'}\nMorador: ${pkg.moradorNome || '-'}\nEndereço: ${pkg.moradorCasa || '-'}\nAguardando retirada há ${days} dia(s).`
        );
        delivery = 'WhatsApp da administração';
      }

      const sentAt = new Date().toISOString();
      writeRuntime(database, pkg.id, {
        stage: due.id,
        claim_until: null,
        sent_at: sentAt,
        retry_after: null,
        attempts,
        last_error: null
      });

      await this.recordEvent(associationId, pkg.id, {
        type: SUCCESS_EVENT,
        title: due.label,
        description: due.audience === 'resident'
          ? 'Lembrete automático de permanência enviado ao morador.'
          : 'Encomenda escalonada automaticamente para acompanhamento da administração.',
        occurredAt: sentAt,
        actor: 'PortalSync', actorRole: 'sistema', source: 'alertas-inteligentes',
        metadata: { alertStage: due.id, audience: due.audience, delivery, ageHours: Math.floor(due.ageHours) }
      });
      clearRuntime(database, pkg.id);
      return { sent: true, stage: due.id, delivery };
    } catch (error) {
      const retryAt = new Date(now.getTime() + due.policy.retryHours * 3600000).toISOString();
      writeRuntime(database, pkg.id, {
        stage: due.id,
        claim_until: null,
        sent_at: null,
        retry_after: retryAt,
        attempts,
        last_error: safeError(error)
      });
      await this.recordEvent(associationId, pkg.id, {
        type: FAILURE_EVENT,
        title: 'Falha no alerta automático',
        description: 'A tentativa automática não foi concluída. O PortalSync programou uma nova tentativa sem alterar o status da encomenda.',
        occurredAt: now,
        actor: 'PortalSync', actorRole: 'sistema', source: 'alertas-inteligentes',
        metadata: { alertStage: due.id, audience: due.audience, attempt: attempts, retryAt, error: safeError(error) }
      });
      return { failed: true, stage: due.id, error: safeError(error), retryAt };
    }
  }

  async runAssociation(associationId) {
    const association = this.associations.require(associationId);
    const now = this.now();
    let state = this.associations.readState(association.id);
    const policy = policyFromState(state);
    const summary = { associationId: association.id, pending: 0, due: 0, sent: 0, failed: 0, skipped: 0, policyEnabled: policy.enabled };
    if (!policy.enabled) return summary;

    ensureRuntimeTable(this.associations.database(association.id));
    for (const original of state.encomendas || []) {
      if (original?.status !== 'pendente') continue;
      summary.pending++;
      state = this.associations.readState(association.id);
      const pkg = (state.encomendas || []).find(item => String(item?.id || '') === String(original.id));
      if (!pkg || pkg.status !== 'pendente') continue;
      const runtime = runtimeState(this.associations.database(association.id), pkg.id);
      if (runtime?.sent_at && runtime?.stage) {
        await this.recoverDelivered(association.id, pkg, runtime);
        state = this.associations.readState(association.id);
      }
      const currentPkg = (state.encomendas || []).find(item => String(item?.id || '') === String(pkg.id)) || pkg;
      const due = dueStage(currentPkg, state, now);
      if (!due) continue;
      summary.due++;
      const result = await this.deliver(association.id, currentPkg, due, now);
      if (result.sent) summary.sent++;
      else if (result.failed) summary.failed++;
      else summary.skipped++;
    }
    return summary;
  }

  async runAll() {
    if (this.running) return this.lastSummary || { skipped: true, reason: 'already-running' };
    this.running = true;
    const aggregate = { associations: 0, pending: 0, due: 0, sent: 0, failed: 0, skipped: 0 };
    try {
      for (const association of this.associations.list().filter(item => item.active !== false)) {
        try {
          const result = await this.runAssociation(association.id);
          aggregate.associations++;
          aggregate.pending += result.pending;
          aggregate.due += result.due;
          aggregate.sent += result.sent;
          aggregate.failed += result.failed;
          aggregate.skipped += result.skipped;
        } catch (error) {
          aggregate.failed++;
          this.lastError = safeError(error);
        }
      }
      this.lastRunAt = new Date().toISOString();
      this.lastSummary = aggregate;
      if (!aggregate.failed) this.lastError = null;
      return aggregate;
    } finally {
      this.running = false;
    }
  }

  start() {
    if (this.timer || this.startTimer) return false;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.runAll().catch(error => { this.lastError = safeError(error); });
      this.timer = setInterval(() => {
        this.runAll().catch(error => { this.lastError = safeError(error); });
      }, this.intervalMs);
      this.timer.unref?.();
    }, this.startupDelayMs);
    this.startTimer.unref?.();
    return true;
  }

  stop() {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.timer) clearInterval(this.timer);
    this.startTimer = null;
    this.timer = null;
  }

  status() {
    return {
      enabled: true,
      running: this.running,
      intervalMinutes: Math.round(this.intervalMs / 60000),
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      lastSummary: this.lastSummary
    };
  }
}

module.exports = {
  PackageAlertService,
  DEFAULT_POLICY,
  SUCCESS_EVENT,
  FAILURE_EVENT,
  normalizePolicy,
  parseDate,
  packageAgeHours,
  stages,
  levelForAge,
  withinSendWindow,
  nextWindowAt,
  sentStages,
  alertEvents,
  policyFromState,
  packageSuspended,
  nextActionAt,
  dueStage,
  ensureRuntimeTable,
  runtimeState,
  clearRuntime
};
