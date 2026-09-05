'use strict';

const crypto = require('crypto');
const { verifyChain } = require('./custody-chain');
const { normalizePolicy, levelForAge } = require('./package-alert-service');
const { parseBusinessDate, localParts, statusOf } = require('./operational-dashboard');

function fail(message, statusCode = 400, code = '') {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  throw error;
}

function cleanText(value, max = 240) {
  return String(value == null ? '' : value).replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizedCode(value) {
  return cleanText(value, 80).toUpperCase().replace(/\s+/g, '');
}

function codeKey(value) {
  return normalizedCode(value).replace(/[^A-Z0-9]/g, '');
}

function actorInfo(actor = {}) {
  return {
    id: cleanText(actor.id, 120),
    name: cleanText(actor.name || actor.nome || actor.id || 'PortalSync', 120),
    role: cleanText(actor.role || actor.perfil || 'sistema', 40),
    ip: cleanText(actor.ip, 80)
  };
}

function ensureState(state) {
  if (!Array.isArray(state.encomendas)) state.encomendas = [];
  if (!Array.isArray(state.moradores)) state.moradores = [];
  if (!Array.isArray(state.auditoria)) state.auditoria = [];
  return state;
}

function ageHours(value, now, offsetMinutes) {
  const date = parseBusinessDate(value, offsetMinutes);
  if (!date) return null;
  return Math.max(0, (now.getTime() - date.getTime()) / 3600000);
}

function publicTimeline(pkg) {
  return (Array.isArray(pkg?.cadeiaCustodia) ? pkg.cadeiaCustodia : []).map(event => ({
    seq: Number(event.seq || 0),
    occurredAt: event.occurredAt || null,
    type: cleanText(event.type, 80),
    title: cleanText(event.title, 140),
    description: cleanText(event.description, 500),
    actor: cleanText(event.actor, 120),
    actorRole: cleanText(event.actorRole, 40),
    source: cleanText(event.source, 80),
    hash: cleanText(event.hash, 80),
    previousHash: cleanText(event.previousHash, 80)
  }));
}

function publicPackage(pkg, options = {}) {
  const integrity = Array.isArray(pkg?.cadeiaCustodia) && pkg.cadeiaCustodia.length
    ? verifyChain(pkg)
    : { ok: true, count: 0, lastHash: null };
  const item = {
    id: String(pkg?.id || ''),
    code: cleanText(pkg?.codigo || pkg?.code, 80),
    status: statusOf(pkg),
    residentId: String(pkg?.moradorId || ''),
    residentName: cleanText(pkg?.moradorNome, 160),
    residentHouse: cleanText(pkg?.moradorCasa, 220),
    carrier: cleanText(pkg?.transportadora, 120),
    notes: cleanText(pkg?.obs, 500),
    entryAt: pkg?.dataEntrada || null,
    withdrawalAt: pkg?.dataRetirada || null,
    withdrawnBy: cleanText(pkg?.retiradoPor, 160),
    withdrawerType: cleanText(pkg?.retiranteTipo, 40),
    cancelledAt: pkg?.dataCancelamento || null,
    cancelledBy: cleanText(pkg?.canceladoPor, 120),
    cancellationReason: cleanText(pkg?.motivoCancelamento, 300),
    reopenedAt: pkg?.dataReabertura || null,
    reopenedBy: cleanText(pkg?.reabertoPor, 120),
    reopeningReason: cleanText(pkg?.motivoReabertura, 300),
    updatedAt: pkg?.cadastroAtualizadoEm || null,
    updatedBy: cleanText(pkg?.cadastroAtualizadoPor, 120),
    lastCorrectionReason: cleanText(pkg?.motivoUltimaCorrecao, 300),
    hasLabelPhoto: !!pkg?.fotoEtiqueta,
    hasSignature: !!pkg?.assinatura,
    hasWithdrawerPhoto: !!pkg?.fotoRetirante,
    custody: {
      ok: integrity.ok === true,
      eventCount: Number(integrity.count || 0),
      lastHash: integrity.lastHash || null,
      reason: integrity.reason || null
    }
  };
  if (options.timeline) item.timeline = publicTimeline(pkg);
  return item;
}

function appendAudit(state, action, pkg, actor, details = {}, occurredAt = new Date()) {
  const who = actorInfo(actor);
  state.auditoria.unshift({
    id: 'aud-pkg-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'),
    data: occurredAt.toISOString(),
    usuarioId: who.id,
    usuarioNome: who.name,
    usuarioPerfil: who.role,
    acao: action,
    origem: 'gestao-encomendas-2',
    ip: who.ip,
    detalhes: {
      encomendaId: String(pkg.id || ''),
      codigo: cleanText(pkg.codigo, 80),
      moradorId: String(pkg.moradorId || ''),
      moradorNome: cleanText(pkg.moradorNome, 160),
      ...details
    }
  });
  state.auditoria = state.auditoria.slice(0, 1000);
}

class PackageManagementService {
  constructor(options = {}) {
    if (!options.associations) throw new Error('AssociationManager é obrigatório.');
    this.associations = options.associations;
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
  }

  state(associationId) {
    return ensureState(this.associations.readState(associationId));
  }

  checkExpectedVersion(state, input = {}) {
    if (input.expectedVersion == null || input.expectedVersion === '') return;
    if (Number(input.expectedVersion) !== Number(state.version || 0)) {
      fail('Os dados foram alterados por outra operação. Atualize a tela e tente novamente.', 409, 'STATE_CHANGED');
    }
  }

  save(associationId, state, baseVersion) {
    const current = this.associations.readState(associationId);
    if (Number(current.version || 0) !== Number(baseVersion || 0)) {
      fail('Os dados foram alterados por outra operação. Atualize a tela e tente novamente.', 409, 'STATE_CHANGED');
    }
    state.version = Math.max(Date.now(), Number(baseVersion || 0) + 1);
    state.updatedAt = this.now().toISOString();
    return this.associations.writeState(associationId, state);
  }

  find(state, id) {
    const pkg = state.encomendas.find(item => String(item?.id || '') === String(id || ''));
    if (!pkg) fail('Encomenda não encontrada.', 404);
    return pkg;
  }

  assertUniqueOpenCode(state, code, excludeId = '') {
    const key = codeKey(code);
    const duplicate = state.encomendas.find(item =>
      String(item?.id || '') !== String(excludeId || '') &&
      statusOf(item) === 'pendente' &&
      codeKey(item?.codigo) === key
    );
    if (duplicate) fail('Já existe uma encomenda aguardando retirada com este código.', 409, 'DUPLICATE_OPEN_CODE');
  }

  list(associationId, filters = {}) {
    const state = this.state(associationId);
    const now = this.now();
    const offsetMinutes = Number.isFinite(Number(filters.timezoneOffsetMinutes)) ? Number(filters.timezoneOffsetMinutes) : -180;
    const policy = normalizePolicy(state.configPublica?.packageAlertsPolicy || {});
    const all = state.encomendas.filter(Boolean).map(pkg => {
      const item = publicPackage(pkg);
      item.ageHours = item.status === 'pendente' ? ageHours(pkg.dataEntrada, now, offsetMinutes) : null;
      item.level = item.status === 'pendente' && Number.isFinite(item.ageHours) ? levelForAge(item.ageHours, policy) : 'normal';
      return item;
    });
    const q = cleanText(filters.q, 160).toLowerCase();
    const status = cleanText(filters.status, 30).toLowerCase();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(filters.from || '')) ? String(filters.from) : '';
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(filters.to || '')) ? String(filters.to) : '';
    const items = all.filter(item => {
      if (status && status !== 'todos' && item.status !== status) return false;
      if (q && ![item.code, item.residentName, item.residentHouse, item.carrier].join(' ').toLowerCase().includes(q)) return false;
      const day = localParts(parseBusinessDate(item.entryAt, offsetMinutes), offsetMinutes)?.day || '';
      if (from && (!day || day < from)) return false;
      if (to && (!day || day > to)) return false;
      return true;
    });
    items.sort((a, b) => {
      const rank = { critical: 4, priority: 3, attention: 2, normal: 1 };
      if (a.status === 'pendente' || b.status === 'pendente') {
        if (a.status !== b.status) return a.status === 'pendente' ? -1 : 1;
        if ((rank[b.level] || 0) !== (rank[a.level] || 0)) return (rank[b.level] || 0) - (rank[a.level] || 0);
        return Number(b.ageHours || 0) - Number(a.ageHours || 0);
      }
      return (parseBusinessDate(b.entryAt, offsetMinutes)?.getTime() || 0) - (parseBusinessDate(a.entryAt, offsetMinutes)?.getTime() || 0);
    });
    const priority = all.filter(item => item.status === 'pendente' && ['priority', 'critical'].includes(item.level)).length;
    return {
      association: this.associations.publicInfo(associationId),
      version: Number(state.version || 0),
      summary: {
        total: all.length,
        pending: all.filter(item => item.status === 'pendente').length,
        withdrawn: all.filter(item => item.status === 'retirado').length,
        cancelled: all.filter(item => item.status === 'cancelado').length,
        priority,
        critical: all.filter(item => item.status === 'pendente' && item.level === 'critical').length,
        filtered: items.length
      },
      residents: state.moradores.filter(Boolean).map(item => ({
        id: String(item.id || ''),
        name: cleanText(item.nome, 160),
        house: cleanText(item.casa, 220)
      })),
      packages: items
    };
  }

  get(associationId, id) {
    const state = this.state(associationId);
    return {
      association: this.associations.publicInfo(associationId),
      version: Number(state.version || 0),
      package: publicPackage(this.find(state, id), { timeline: true })
    };
  }

  update(associationId, id, input = {}, actor = {}) {
    const state = this.state(associationId);
    this.checkExpectedVersion(state, input);
    const baseVersion = Number(state.version || 0);
    const pkg = this.find(state, id);
    if (statusOf(pkg) !== 'pendente') fail('Somente encomendas aguardando retirada podem ser corrigidas.', 409, 'PACKAGE_NOT_PENDING');

    const reason = cleanText(input.reason || input.motivo, 300);
    if (reason.length < 5) fail('Informe o motivo da correção.');
    const code = normalizedCode(input.code ?? input.codigo ?? pkg.codigo);
    if (code.length < 8) fail('O código da encomenda deve possuir ao menos 8 caracteres.');
    this.assertUniqueOpenCode(state, code, id);
    const residentId = String(input.residentId ?? input.moradorId ?? pkg.moradorId ?? '');
    const resident = state.moradores.find(item => String(item?.id || '') === residentId);
    if (!resident) fail('Selecione um morador ativo.', 400);
    const carrier = cleanText(input.carrier ?? input.transportadora ?? pkg.transportadora, 120) || 'Não informada';
    const notes = cleanText(input.notes ?? input.obs ?? pkg.obs, 500);
    const before = {
      codigo: cleanText(pkg.codigo, 80),
      transportadora: cleanText(pkg.transportadora, 120),
      obs: cleanText(pkg.obs, 500),
      moradorId: String(pkg.moradorId || ''),
      moradorNome: cleanText(pkg.moradorNome, 160),
      moradorCasa: cleanText(pkg.moradorCasa, 220)
    };
    const after = {
      codigo: code,
      transportadora: carrier,
      obs: notes,
      moradorId: residentId,
      moradorNome: cleanText(resident.nome, 160),
      moradorCasa: cleanText(resident.casa, 220)
    };
    if (JSON.stringify(before) === JSON.stringify(after)) fail('Nenhuma alteração foi informada.');
    Object.assign(pkg, after, {
      moradorWhats: resident.whats || '',
      cadastroAtualizadoEm: this.now().toISOString(),
      cadastroAtualizadoPor: actorInfo(actor).name,
      motivoUltimaCorrecao: reason
    });
    appendAudit(state, 'Encomenda corrigida', pkg, actor, { motivo: reason, antes: before, depois: after }, this.now());
    this.save(associationId, state, baseVersion);
    return this.get(associationId, id);
  }

  cancel(associationId, id, input = {}, actor = {}) {
    const state = this.state(associationId);
    this.checkExpectedVersion(state, input);
    const baseVersion = Number(state.version || 0);
    const pkg = this.find(state, id);
    if (statusOf(pkg) !== 'pendente') fail('Somente encomendas aguardando retirada podem ser canceladas.', 409, 'PACKAGE_NOT_PENDING');
    const reason = cleanText(input.reason || input.motivo, 300);
    if (reason.length < 5) fail('Informe o motivo do cancelamento.');
    const who = actorInfo(actor);
    pkg.status = 'cancelado';
    pkg.dataCancelamento = this.now().toISOString();
    pkg.canceladoPor = who.name;
    pkg.motivoCancelamento = reason;
    appendAudit(state, 'Encomenda cancelada', pkg, actor, { motivo: reason }, this.now());
    this.save(associationId, state, baseVersion);
    return this.get(associationId, id);
  }

  reopen(associationId, id, input = {}, actor = {}) {
    const state = this.state(associationId);
    this.checkExpectedVersion(state, input);
    const baseVersion = Number(state.version || 0);
    const pkg = this.find(state, id);
    if (statusOf(pkg) !== 'cancelado') fail('Somente encomendas canceladas podem ser reabertas.', 409, 'PACKAGE_NOT_CANCELLED');
    const reason = cleanText(input.reason || input.motivo, 300);
    if (reason.length < 5) fail('Informe o motivo da reabertura.');
    this.assertUniqueOpenCode(state, pkg.codigo, id);
    const who = actorInfo(actor);
    if (!Array.isArray(pkg.historicoCancelamentos)) pkg.historicoCancelamentos = [];
    pkg.historicoCancelamentos.push({
      data: pkg.dataCancelamento || null,
      por: cleanText(pkg.canceladoPor, 120),
      motivo: cleanText(pkg.motivoCancelamento, 300)
    });
    pkg.status = 'pendente';
    pkg.dataReabertura = this.now().toISOString();
    pkg.reabertoPor = who.name;
    pkg.motivoReabertura = reason;
    delete pkg.dataCancelamento;
    delete pkg.canceladoPor;
    delete pkg.motivoCancelamento;
    appendAudit(state, 'Encomenda reaberta', pkg, actor, { motivo: reason }, this.now());
    this.save(associationId, state, baseVersion);
    return this.get(associationId, id);
  }
}

module.exports = { PackageManagementService, publicPackage, normalizedCode, codeKey };
