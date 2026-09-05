'use strict';

const crypto = require('crypto');

const ARCHIVE_KEY = 'moradoresInativos';

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizePhone(value) {
  let raw = digits(value);
  if (!raw) return '';
  if (raw.startsWith('55') && (raw.length === 12 || raw.length === 13)) raw = raw.slice(2);
  if (raw.length !== 10 && raw.length !== 11) {
    const error = new Error('WhatsApp deve conter DDD e número, com 10 ou 11 dígitos.');
    error.statusCode = 400;
    throw error;
  }
  return raw;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(value, max = 160) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function exactKey(value) {
  return normalizeText(value?.nome) + '|' + normalizeText(value?.casa);
}

function publicResident(value, active = true) {
  if (!value) return null;
  return {
    id: String(value.id || ''),
    nome: String(value.nome || ''),
    casa: String(value.casa || ''),
    whats: digits(value.whats),
    tipo: String(value.tipo || ''),
    ativo: active,
    cadastroFonte: value.cadastroFonte || null,
    cadastroAtualizadoEm: value.cadastroAtualizadoEm || null,
    desativadoEm: value.desativadoEm || null,
    desativadoPor: value.desativadoPor || null,
    motivoDesativacao: value.motivoDesativacao || null
  };
}

function statusError(message, code) {
  const error = new Error(message);
  error.statusCode = code;
  return error;
}

function archivedFromState(state) {
  const config = state?.configPublica && typeof state.configPublica === 'object' ? state.configPublica : {};
  return Array.isArray(config[ARCHIVE_KEY]) ? config[ARCHIVE_KEY].filter(Boolean) : [];
}

function ensureStateCollections(state) {
  if (!Array.isArray(state.moradores)) state.moradores = [];
  if (!Array.isArray(state.auditoria)) state.auditoria = [];
  if (!state.configPublica || typeof state.configPublica !== 'object' || Array.isArray(state.configPublica)) state.configPublica = {};
  if (!Array.isArray(state.configPublica[ARCHIVE_KEY])) state.configPublica[ARCHIVE_KEY] = [];
  return state;
}

function actorName(actor) {
  return cleanText(actor?.name || actor?.nome || actor?.id || 'Administrador', 120);
}

function appendAudit(state, action, resident, actor, extra = {}) {
  state.auditoria.push({
    acao: action,
    data: new Date().toISOString(),
    usuario: actorName(actor),
    moradorId: String(resident?.id || ''),
    moradorNome: String(resident?.nome || ''),
    casa: String(resident?.casa || ''),
    origem: 'gestao-moradores',
    ip: String(actor?.ip || '').slice(0, 80),
    ...extra
  });
}

class ResidentManagementService {
  constructor(options = {}) {
    if (!options.associations) throw new Error('AssociationManager é obrigatório.');
    this.associations = options.associations;
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.idGenerator = typeof options.idGenerator === 'function'
      ? options.idGenerator
      : () => 'mor-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  }

  state(associationId) {
    return ensureStateCollections(this.associations.readState(associationId));
  }

  save(associationId, state) {
    state.version = Date.now();
    state.updatedAt = this.now().toISOString();
    return this.associations.writeState(associationId, state);
  }

  validateInput(input = {}) {
    const nome = cleanText(input.nome || input.name, 140);
    const casa = cleanText(input.casa || input.endereco || input.address, 220);
    const tipo = cleanText(input.tipo || input.type, 80);
    if (nome.length < 3) throw statusError('Informe o nome do morador.', 400);
    if (casa.length < 3) throw statusError('Informe o endereço/unidade do morador.', 400);
    const whats = normalizePhone(input.whats || input.whatsapp || input.phone || '');
    return { nome, casa, whats, tipo };
  }

  duplicates(state, input, excludeId = '') {
    const key = exactKey(input);
    const phone = digits(input.whats);
    const active = state.moradores.filter(item => String(item?.id || '') !== String(excludeId || ''));
    const archived = archivedFromState(state).filter(item => String(item?.id || '') !== String(excludeId || ''));
    const exactActive = active.filter(item => exactKey(item) === key);
    const exactArchived = archived.filter(item => exactKey(item) === key);
    const sharedPhone = phone ? active.filter(item => digits(item.whats) === phone) : [];
    const sharedAddress = active.filter(item => normalizeText(item.casa) === normalizeText(input.casa));
    return {
      exactActive: exactActive.map(item => publicResident(item, true)),
      exactArchived: exactArchived.map(item => publicResident(item, false)),
      sharedPhone: sharedPhone.map(item => publicResident(item, true)),
      sharedAddress: sharedAddress.map(item => publicResident(item, true))
    };
  }

  duplicateSummary(state) {
    const byPhone = new Map();
    const byExact = new Map();
    for (const item of state.moradores) {
      const phone = digits(item.whats);
      if (phone) {
        if (!byPhone.has(phone)) byPhone.set(phone, []);
        byPhone.get(phone).push(item);
      }
      const key = exactKey(item);
      if (!byExact.has(key)) byExact.set(key, []);
      byExact.get(key).push(item);
    }
    return {
      exact: Array.from(byExact.values()).filter(list => list.length > 1).map(list => list.map(item => publicResident(item, true))),
      sharedPhones: Array.from(byPhone.values()).filter(list => list.length > 1).map(list => list.map(item => publicResident(item, true)))
    };
  }

  list(associationId) {
    const state = this.state(associationId);
    const active = state.moradores.map(item => publicResident(item, true));
    const inactive = archivedFromState(state).map(item => publicResident(item, false));
    const duplicates = this.duplicateSummary(state);
    return {
      association: this.associations.publicInfo(associationId),
      residents: [...active, ...inactive],
      summary: {
        active: active.length,
        inactive: inactive.length,
        total: active.length + inactive.length,
        withoutWhatsapp: active.filter(item => !item.whats).length,
        exactDuplicates: duplicates.exact.length,
        sharedPhones: duplicates.sharedPhones.length
      },
      duplicates
    };
  }

  create(associationId, input, actor = {}) {
    const state = this.state(associationId);
    const clean = this.validateInput(input);
    const duplicateInfo = this.duplicates(state, clean);
    if (duplicateInfo.exactActive.length) throw statusError('Já existe um morador ativo com o mesmo nome e endereço.', 409);
    if (duplicateInfo.exactArchived.length) throw statusError('Existe um cadastro inativo com o mesmo nome e endereço. Reative o cadastro existente.', 409);
    if (duplicateInfo.sharedPhone.length && input.allowSharedPhone !== true) {
      const error = statusError('Este WhatsApp já está vinculado a outro morador. Confirme o compartilhamento do número para continuar.', 409);
      error.code = 'SHARED_PHONE';
      error.duplicates = duplicateInfo.sharedPhone;
      throw error;
    }
    const resident = {
      id: this.idGenerator(),
      ...clean,
      ativo: true,
      cadastroFonte: 'Gestão de Moradores',
      cadastroAtualizadoEm: this.now().toISOString()
    };
    state.moradores.push(resident);
    appendAudit(state, 'Morador cadastrado', resident, actor);
    this.save(associationId, state);
    return { resident: publicResident(resident, true), duplicates: duplicateInfo };
  }

  update(associationId, id, input, actor = {}) {
    const state = this.state(associationId);
    const resident = state.moradores.find(item => String(item?.id || '') === String(id || ''));
    if (!resident) throw statusError('Morador ativo não encontrado.', 404);
    const clean = this.validateInput(input);
    const duplicateInfo = this.duplicates(state, clean, id);
    if (duplicateInfo.exactActive.length) throw statusError('Outro morador ativo já possui o mesmo nome e endereço.', 409);
    if (duplicateInfo.sharedPhone.length && input.allowSharedPhone !== true) {
      const error = statusError('Este WhatsApp já está vinculado a outro morador. Confirme o compartilhamento do número para continuar.', 409);
      error.code = 'SHARED_PHONE';
      error.duplicates = duplicateInfo.sharedPhone;
      throw error;
    }
    const before = { nome: resident.nome, casa: resident.casa, whats: digits(resident.whats), tipo: resident.tipo || '' };
    resident.nome = clean.nome;
    resident.casa = clean.casa;
    resident.whats = clean.whats;
    resident.tipo = clean.tipo;
    resident.ativo = true;
    resident.cadastroFonte = 'Gestão de Moradores';
    resident.cadastroAtualizadoEm = this.now().toISOString();
    appendAudit(state, 'Morador atualizado', resident, actor, { antes: before });
    this.save(associationId, state);
    return { resident: publicResident(resident, true), duplicates: duplicateInfo };
  }

  deactivate(associationId, id, reason, actor = {}) {
    const state = this.state(associationId);
    const index = state.moradores.findIndex(item => String(item?.id || '') === String(id || ''));
    if (index < 0) throw statusError('Morador ativo não encontrado.', 404);
    const resident = state.moradores[index];
    const pending = (state.encomendas || []).filter(item => String(item?.moradorId || '') === String(id) && String(item?.status || '') === 'pendente');
    if (pending.length) {
      const error = statusError('O morador possui encomenda(s) pendente(s). Conclua ou regularize as encomendas antes da desativação.', 409);
      error.code = 'PENDING_PACKAGES';
      error.pendingPackages = pending.map(item => ({ id: item.id, codigo: item.codigo || '', dataEntrada: item.dataEntrada || null }));
      throw error;
    }
    const motivo = cleanText(reason, 240);
    if (motivo.length < 5) throw statusError('Informe o motivo da desativação.', 400);
    state.moradores.splice(index, 1);
    const archived = {
      ...resident,
      ativo: false,
      desativadoEm: this.now().toISOString(),
      desativadoPor: actorName(actor),
      motivoDesativacao: motivo,
      cadastroAtualizadoEm: this.now().toISOString()
    };
    state.configPublica[ARCHIVE_KEY].push(archived);
    appendAudit(state, 'Morador desativado', archived, actor, { motivo: motivo });
    this.save(associationId, state);
    return { resident: publicResident(archived, false) };
  }

  reactivate(associationId, id, actor = {}, options = {}) {
    const state = this.state(associationId);
    const archive = state.configPublica[ARCHIVE_KEY];
    const index = archive.findIndex(item => String(item?.id || '') === String(id || ''));
    if (index < 0) throw statusError('Morador inativo não encontrado.', 404);
    const resident = archive[index];
    const duplicateInfo = this.duplicates(state, resident, id);
    if (duplicateInfo.exactActive.length) throw statusError('Já existe um morador ativo com o mesmo nome e endereço.', 409);
    if (duplicateInfo.sharedPhone.length && options.allowSharedPhone !== true) {
      const error = statusError('O WhatsApp do cadastro inativo já está vinculado a outro morador ativo.', 409);
      error.code = 'SHARED_PHONE';
      error.duplicates = duplicateInfo.sharedPhone;
      throw error;
    }
    archive.splice(index, 1);
    const active = {
      ...resident,
      ativo: true,
      reativadoEm: this.now().toISOString(),
      cadastroAtualizadoEm: this.now().toISOString()
    };
    delete active.desativadoEm;
    delete active.desativadoPor;
    delete active.motivoDesativacao;
    state.moradores.push(active);
    appendAudit(state, 'Morador reativado', active, actor);
    this.save(associationId, state);
    return { resident: publicResident(active, true), duplicates: duplicateInfo };
  }

  prepareImport(associationId, rows = [], options = {}) {
    if (!Array.isArray(rows)) throw statusError('A importação deve conter uma lista de moradores.', 400);
    if (rows.length > 2000) throw statusError('Importação limitada a 2.000 registros por operação.', 400);
    const state = this.state(associationId);
    const simulated = state.moradores.map(item => ({ ...item }));
    const archived = archivedFromState(state);
    const resultRows = [];
    let add = 0;
    let update = 0;
    let unchanged = 0;
    let conflicts = 0;
    let invalid = 0;

    rows.forEach((raw, index) => {
      let clean;
      try { clean = this.validateInput(raw || {}); }
      catch (error) {
        invalid++;
        resultRows.push({ index, action: 'invalid', error: error.message, input: raw });
        return;
      }
      const key = exactKey(clean);
      const exact = simulated.find(item => exactKey(item) === key);
      const inactive = archived.find(item => exactKey(item) === key);
      const sharedPhone = clean.whats ? simulated.filter(item => digits(item.whats) === clean.whats && (!exact || item.id !== exact.id)) : [];
      if (inactive && !exact) {
        conflicts++;
        resultRows.push({ index, action: 'conflict', reason: 'Cadastro idêntico está inativo. Reative-o manualmente.', input: clean, residentId: inactive.id });
        return;
      }
      if (sharedPhone.length && options.allowSharedPhone !== true) {
        conflicts++;
        resultRows.push({ index, action: 'conflict', reason: 'WhatsApp compartilhado com outro morador.', input: clean, duplicates: sharedPhone.map(item => publicResident(item, true)) });
        return;
      }
      if (exact) {
        const changed = String(exact.whats || '') !== clean.whats || String(exact.tipo || '') !== clean.tipo || String(exact.nome || '') !== clean.nome || String(exact.casa || '') !== clean.casa;
        if (changed) {
          Object.assign(exact, clean);
          update++;
          resultRows.push({ index, action: 'update', residentId: exact.id, input: clean });
        } else {
          unchanged++;
          resultRows.push({ index, action: 'unchanged', residentId: exact.id, input: clean });
        }
        return;
      }
      const fake = { id: '__import_' + index, ...clean };
      simulated.push(fake);
      add++;
      resultRows.push({ index, action: 'add', input: clean });
    });

    return {
      rows: resultRows,
      summary: { source: rows.length, add, update, unchanged, conflicts, invalid, applicable: add + update }
    };
  }

  importRows(associationId, rows = [], options = {}, actor = {}) {
    const preview = this.prepareImport(associationId, rows, options);
    if (preview.summary.invalid || preview.summary.conflicts) {
      const error = statusError('A importação possui registros inválidos ou conflitos. Revise a prévia antes de confirmar.', 409);
      error.code = 'IMPORT_REVIEW_REQUIRED';
      error.preview = preview;
      throw error;
    }
    const state = this.state(associationId);
    let added = 0;
    let updated = 0;
    for (const row of preview.rows) {
      if (row.action === 'unchanged') continue;
      if (row.action === 'update') {
        const target = state.moradores.find(item => String(item?.id || '') === String(row.residentId || ''));
        if (!target) continue;
        Object.assign(target, row.input, {
          ativo: true,
          cadastroFonte: 'Importação - Gestão de Moradores',
          cadastroAtualizadoEm: this.now().toISOString()
        });
        updated++;
      } else if (row.action === 'add') {
        state.moradores.push({
          id: this.idGenerator(),
          ...row.input,
          ativo: true,
          cadastroFonte: 'Importação - Gestão de Moradores',
          cadastroAtualizadoEm: this.now().toISOString()
        });
        added++;
      }
    }
    appendAudit(state, 'Importação de moradores concluída', { id: '', nome: '', casa: '' }, actor, {
      adicionados: added,
      atualizados: updated,
      totalFonte: rows.length
    });
    this.save(associationId, state);
    return { ok: true, added, updated, unchanged: preview.summary.unchanged, summary: this.list(associationId).summary };
  }
}

module.exports = {
  ResidentManagementService,
  ARCHIVE_KEY,
  normalizePhone,
  normalizeText,
  exactKey,
  publicResident
};
