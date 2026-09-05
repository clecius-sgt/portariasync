'use strict';

const crypto = require('crypto');
const { verifyChain } = require('./custody-chain');
const Reports = require('./managerial-reports');

const SOURCE_LABELS = Object.freeze({
  operational: 'Operação',
  custody: 'Cadeia de custódia',
  access: 'Acessos e sessões',
  occurrence: 'Ocorrências'
});

const ACCESS_LABELS = Object.freeze({
  legacy_users_migrated: 'Usuários legados importados',
  user_created: 'Usuário criado',
  login_failed: 'Tentativa de acesso recusada',
  login_blocked: 'Acesso temporariamente bloqueado',
  user_temporarily_locked: 'Usuário temporariamente bloqueado',
  login_succeeded: 'Acesso realizado',
  session_association_switched: 'Associação da sessão alterada',
  logout: 'Sessão encerrada',
  user_activated: 'Usuário ativado',
  user_deactivated: 'Usuário desativado',
  password_reset: 'Senha redefinida',
  sessions_revoked: 'Sessões encerradas pela administração'
});

const SENSITIVE_KEY = /pin|senha|password|token|secret|codigo.?hash|codigo.?salt|assinatura|foto|imagem|whats|telefone|documento|cpf|cnpj|\brg\b/i;

function text(value, max = 500) {
  return String(value == null ? '' : value).replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function scrub(value, depth = 0) {
  if (depth > 3) return null;
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return /^data:/i.test(value) ? '[conteúdo protegido]' : text(value, 300);
  if (Array.isArray(value)) return value.slice(0, 20).map(item => scrub(item, depth + 1));
  if (typeof value !== 'object') return text(value, 300);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) continue;
    out[key] = scrub(item, depth + 1);
  }
  return out;
}

function detailText(value) {
  if (typeof value === 'string') return text(value, 700);
  const clean = scrub(value);
  if (!clean || (typeof clean === 'object' && !Object.keys(clean).length)) return '';
  return text(JSON.stringify(clean), 700);
}

function iso(value) {
  const date = Reports.parseDate(value);
  return date ? date.toISOString() : null;
}

function operationalEvents(state) {
  return (Array.isArray(state?.auditoria) ? state.auditoria : []).filter(Boolean).map((item, index) => {
    const details = item.detalhes && typeof item.detalhes === 'object' ? item.detalhes : {};
    const action = text(item.acao || item.action || 'Evento operacional', 160);
    return {
      id: 'operational:' + text(item.id || index, 160),
      occurredAt: iso(item.data || item.ocorridoEm || item.createdAt),
      source: 'operational',
      sourceLabel: SOURCE_LABELS.operational,
      category: 'operation',
      action,
      actor: text(item.usuarioNome || item.usuario || 'PortalSync', 120),
      actorRole: text(item.usuarioPerfil || item.perfil || 'sistema', 40),
      target: text(details.codigo || details.moradorNome || details.usuarioAlvo || details.casa, 220),
      detail: detailText(details),
      ip: text(item.ip, 128),
      hash: null,
      integrity: 'not_applicable'
    };
  });
}

function custodyEvents(state) {
  const events = [];
  for (const pkg of Array.isArray(state?.encomendas) ? state.encomendas : []) {
    for (const event of Array.isArray(pkg?.cadeiaCustodia) ? pkg.cadeiaCustodia : []) {
      events.push({
        id: 'custody:' + text(event.id || `${pkg.id}:${event.seq}`, 200),
        occurredAt: iso(event.occurredAt || event.recordedAt),
        source: 'custody',
        sourceLabel: SOURCE_LABELS.custody,
        category: 'custody',
        action: text(event.title || event.type || 'Evento da encomenda', 160),
        actor: text(event.actor || 'PortalSync', 120),
        actorRole: text(event.actorRole || 'sistema', 40),
        target: text([pkg.codigo, pkg.moradorNome].filter(Boolean).join(' · '), 220),
        detail: text(event.description, 700),
        ip: '',
        hash: text(event.hash, 80) || null,
        integrity: 'verified'
      });
    }
  }
  return events;
}

function accessEvents(access, associationId) {
  return access.listEvents({ associationId, limit: 5000 }).map(event => {
    const type = text(event.type, 100);
    return {
      id: 'access:' + event.id,
      occurredAt: iso(event.occurredAt),
      source: 'access',
      sourceLabel: SOURCE_LABELS.access,
      category: ['login_failed', 'login_blocked', 'user_temporarily_locked'].includes(type) ? 'security' : 'access',
      action: ACCESS_LABELS[type] || type || 'Evento de acesso',
      actor: text(event.actorName || event.actorUserId || 'Sistema', 120),
      actorRole: 'controle de acesso',
      target: text(event.targetName || event.targetUserId, 160),
      detail: detailText(event.detail),
      ip: text(event.ip, 128),
      hash: null,
      integrity: 'database'
    };
  });
}

function occurrenceEvents(occurrences, associationId) {
  const output = [];
  const integrity = { total: 0, valid: 0, invalid: 0, events: 0 };
  const listed = occurrences.list(associationId, {}).occurrences || [];
  for (const occurrence of listed) {
    const detail = occurrences.get(associationId, occurrence.id);
    integrity.total += 1;
    integrity.events += detail.events.length;
    if (detail.integrity.status === 'ok') integrity.valid += 1;
    else integrity.invalid += 1;
    for (const event of detail.events) {
      output.push({
        id: 'occurrence:' + text(event.id || `${occurrence.id}:${event.sequence}`, 200),
        occurredAt: iso(event.occurredAt || event.recordedAt),
        source: 'occurrence',
        sourceLabel: SOURCE_LABELS.occurrence,
        category: 'occurrence',
        action: text(event.title || event.type || 'Evento de ocorrência', 160),
        actor: text(event.actor?.name || event.actorName || 'PortalSync', 120),
        actorRole: text(event.actor?.role || event.actorRole || 'sistema', 40),
        target: text([occurrence.number, occurrence.packageCode, occurrence.residentName].filter(Boolean).join(' · '), 220),
        detail: text(event.description, 700),
        ip: '',
        hash: text(event.hash, 80) || null,
        integrity: detail.integrity.status === 'ok' ? 'verified' : 'failed'
      });
    }
  }
  return { events: output, integrity };
}

function packageIntegrity(state) {
  const result = { total: 0, valid: 0, invalid: 0, missing: 0, events: 0 };
  for (const pkg of Array.isArray(state?.encomendas) ? state.encomendas : []) {
    result.total += 1;
    const chain = Array.isArray(pkg?.cadeiaCustodia) ? pkg.cadeiaCustodia : [];
    result.events += chain.length;
    if (!chain.length) result.missing += 1;
    else if (verifyChain(pkg).ok) result.valid += 1;
    else result.invalid += 1;
  }
  return result;
}

function matchesPeriod(event, period) {
  const date = Reports.parseDate(event.occurredAt);
  return !!date && date >= period.start && date <= period.end;
}

function reportHash(events) {
  const evidence = events.map(event => [event.id, event.occurredAt, event.source, event.action, event.hash || '']);
  return crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

class AdvancedAuditService {
  constructor(options = {}) {
    if (!options.associations || !options.access || !options.occurrences) throw new Error('Dependências da auditoria avançada são obrigatórias.');
    this.associations = options.associations;
    this.access = options.access;
    this.occurrences = options.occurrences;
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
  }

  build(associationId, filters = {}) {
    const now = this.now();
    const state = this.associations.readState(associationId);
    const database = this.associations.database(associationId);
    const period = Reports.resolvePeriod({ mode: filters.mode || '30', start: filters.start, end: filters.end }, now);
    const occurrence = occurrenceEvents(this.occurrences, associationId);
    const all = [
      ...operationalEvents(state),
      ...custodyEvents(state),
      ...accessEvents(this.access, associationId),
      ...occurrence.events
    ].filter(event => matchesPeriod(event, period));
    const source = text(filters.source, 30).toLowerCase();
    const category = text(filters.category, 30).toLowerCase();
    const actor = text(filters.actor, 120).toLowerCase();
    const q = text(filters.q, 180).toLowerCase();
    const events = all.filter(event => {
      if (source && source !== 'all' && event.source !== source) return false;
      if (category && category !== 'all' && event.category !== category) return false;
      if (actor && !event.actor.toLowerCase().includes(actor)) return false;
      if (q && ![event.action, event.actor, event.actorRole, event.target, event.detail, event.ip].join(' ').toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => String(b.occurredAt || '').localeCompare(String(a.occurredAt || '')) || b.id.localeCompare(a.id));
    const packageChains = packageIntegrity(state);
    const databaseStatus = database.status();
    const overall = databaseStatus.integrity !== 'ok' || packageChains.invalid || occurrence.integrity.invalid
      ? 'error'
      : packageChains.missing
        ? 'warning'
        : 'ok';
    const actors = Array.from(new Set(all.map(event => event.actor).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'pt-BR'));
    return {
      generatedAt: now.toISOString(),
      association: this.associations.publicInfo(associationId),
      period: { start: period.start.toISOString(), end: period.end.toISOString() },
      filters: { source: source || 'all', category: category || 'all', actor: text(filters.actor, 120), q: text(filters.q, 180) },
      summary: {
        total: events.length,
        operational: events.filter(event => event.source === 'operational').length,
        custody: events.filter(event => event.source === 'custody').length,
        access: events.filter(event => event.source === 'access').length,
        occurrences: events.filter(event => event.source === 'occurrence').length,
        securityAlerts: events.filter(event => event.category === 'security').length
      },
      integrity: {
        overall,
        database: databaseStatus.integrity,
        appendOnly: databaseStatus.custody?.appendOnly === true,
        packageChains,
        occurrenceChains: occurrence.integrity
      },
      actors,
      reportHash: reportHash(events),
      events: events.slice(0, 2000)
    };
  }
}

module.exports = {
  AdvancedAuditService,
  SOURCE_LABELS,
  ACCESS_LABELS,
  scrub,
  operationalEvents,
  custodyEvents,
  packageIntegrity,
  reportHash
};
