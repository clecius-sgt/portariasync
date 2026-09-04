'use strict';

const crypto = require('crypto');
const { appendEvent } = require('./custody-chain');
const { receiptForPackage } = require('./withdrawal-receipt');
const {
  OCCURRENCE_TABLE,
  TYPES,
  PRIORITIES,
  STATUSES,
  OUTCOMES,
  ensureOccurrenceTables,
  allocateOccurrenceNumber,
  appendOccurrenceEvent,
  readOccurrenceEvents,
  verifyOccurrenceEvents,
  rowPublic,
  cleanText
} = require('./occurrence-service');

const RESIDENT_TYPES = Object.freeze({
  contestacao_retirada: 'Contestação de retirada',
  encomenda_danificada: 'Encomenda danificada',
  encomenda_nao_localizada: 'Encomenda não localizada',
  outro: 'Outro problema com a encomenda'
});

const ACTIVE_STATUSES = new Set(['aberta', 'em_apuracao', 'aguardando_informacao']);

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function residentIdsSet(ids) {
  return new Set((ids || []).map(value => String(value || '')).filter(Boolean));
}

function actorPublic(actor = {}) {
  return {
    id: cleanText(actor.id || 'portal-morador', 120),
    name: cleanText(actor.name || actor.nome || 'Morador pelo Portal', 120),
    role: 'morador',
    ip: cleanText(actor.ip, 120)
  };
}

function residentOccurrence(row) {
  const item = rowPublic(row);
  if (!item) return null;
  return {
    id: item.id,
    occurrenceNumber: item.occurrenceNumber,
    packageId: item.packageId,
    packageCode: item.packageCode,
    residentName: item.residentName,
    residentHouse: item.residentHouse,
    receiptNumber: item.receiptNumber,
    type: item.type,
    typeLabel: item.typeLabel,
    priority: item.priority,
    priorityLabel: item.priorityLabel,
    status: item.status,
    statusLabel: item.statusLabel,
    title: item.title,
    description: item.description,
    outcome: item.outcome,
    outcomeLabel: item.outcomeLabel,
    conclusion: item.status === 'concluida' ? item.conclusion : null,
    openedAt: item.openedAt,
    updatedAt: item.updatedAt,
    closedAt: item.closedAt
  };
}

function residentTimeline(events, occurrence) {
  const publicEvents = [];
  for (const event of events || []) {
    const type = String(event?.type || '');
    const base = { type, occurredAt: event?.occurredAt || null };
    if (type === 'occurrence_opened') {
      publicEvents.push({ ...base, title: 'Ocorrência registrada', description: occurrence?.description || event?.description || '' });
      continue;
    }
    if (type === 'resident_statement') {
      publicEvents.push({ ...base, title: 'Manifestação adicionada', description: event?.description || '' });
      continue;
    }
    if (type === 'status_changed') {
      const current = String(event?.metadata?.current || '');
      publicEvents.push({ ...base, title: 'Andamento atualizado', description: current && STATUSES[current] ? `Status: ${STATUSES[current]}.` : 'O andamento da ocorrência foi atualizado.' });
      continue;
    }
    if (type === 'occurrence_concluded') {
      publicEvents.push({
        ...base,
        title: 'Ocorrência concluída',
        description: occurrence?.outcomeLabel ? `Resultado: ${occurrence.outcomeLabel}.` : 'A apuração foi concluída.'
      });
      continue;
    }
    if (type === 'occurrence_reopened') {
      publicEvents.push({ ...base, title: 'Ocorrência reaberta', description: 'A apuração foi reaberta para nova análise.' });
      continue;
    }
    if (type === 'occurrence_cancelled') {
      publicEvents.push({ ...base, title: 'Ocorrência cancelada', description: 'O registro foi cancelado administrativamente, sem exclusão do histórico.' });
    }
  }
  return publicEvents;
}

class ResidentOccurrenceService {
  constructor(options = {}) {
    if (!options.associations) throw new Error('AssociationManager é obrigatório.');
    this.associations = options.associations;
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
  }

  database(associationId) {
    const association = this.associations.require(associationId);
    const database = this.associations.database(association.id);
    ensureOccurrenceTables(database);
    return { association, database };
  }

  ownedPackage(associationId, residentIds, packageId) {
    const allowed = residentIdsSet(residentIds);
    const state = this.associations.readState(associationId);
    const pkg = (state.encomendas || []).find(item => String(item?.id || '') === String(packageId || ''));
    if (!pkg || !allowed.has(String(pkg.moradorId || ''))) fail('Encomenda não encontrada para este morador.', 404);
    return { state, pkg };
  }

  assertOccurrenceOwnership(row, residentIds) {
    const allowed = residentIdsSet(residentIds);
    if (!row || row.created_by_role !== 'morador' || !allowed.has(String(row.resident_id || ''))) {
      fail('Ocorrência não encontrada para este morador.', 404);
    }
  }

  activeForPackage(database, packageId, residentIds) {
    const allowed = residentIdsSet(residentIds);
    return database.db.prepare(`
      SELECT * FROM ${OCCURRENCE_TABLE}
      WHERE package_id = ? AND created_by_role = 'morador'
        AND status IN ('aberta','em_apuracao','aguardando_informacao')
      ORDER BY opened_at DESC
    `).all(String(packageId || '')).find(row => allowed.has(String(row.resident_id || ''))) || null;
  }

  validateType(pkg, type) {
    if (!RESIDENT_TYPES[type]) fail('Tipo de ocorrência inválido.');
    const status = String(pkg?.status || '');
    if (status === 'cancelado') fail('Não é possível abrir ocorrência pelo Portal do Morador para encomenda cancelada.', 409);
    if (type === 'contestacao_retirada' && status !== 'retirado') {
      fail('Contestação de retirada somente pode ser aberta após a retirada da encomenda.', 409);
    }
    if (type === 'encomenda_nao_localizada' && status !== 'pendente') {
      fail('O relato de encomenda não localizada é destinado a encomendas que ainda aguardam retirada.', 409);
    }
  }

  create(associationId, residentIds, packageId, input = {}, actor = {}) {
    const { association, database } = this.database(associationId);
    const { pkg } = this.ownedPackage(association.id, residentIds, packageId);
    const type = cleanText(input.type, 80);
    this.validateType(pkg, type);
    const description = cleanText(input.description, 4000);
    if (description.length < 20) fail('Descreva o problema com pelo menos 20 caracteres.');
    const existing = this.activeForPackage(database, pkg.id, residentIds);
    if (existing) fail(`Já existe a ocorrência ${existing.occurrence_number} em andamento para esta encomenda.`, 409);

    const at = this.now();
    const openedAt = at.toISOString();
    const occurrenceNumber = allocateOccurrenceNumber(database, at.getUTCFullYear());
    const id = 'oc-' + crypto.randomBytes(12).toString('hex');
    const priority = type === 'contestacao_retirada' ? 'alta' : 'normal';
    const title = RESIDENT_TYPES[type];
    const receipt = receiptForPackage(database, pkg.id);
    const publicActor = actorPublic(actor);

    database.transaction(() => {
      database.db.prepare(`
        INSERT INTO ${OCCURRENCE_TABLE}(
          id, occurrence_number, package_id, package_code, resident_id, resident_name, resident_house,
          receipt_number, receipt_hash, type, priority, status, title, description, outcome, conclusion,
          opened_at, updated_at, closed_at, created_by_id, created_by_name, created_by_role, last_event_hash
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aberta', ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, 'morador', NULL)
      `).run(
        id, occurrenceNumber, String(pkg.id), cleanText(pkg.codigo, 160), cleanText(pkg.moradorId, 160),
        cleanText(pkg.moradorNome, 200), cleanText(pkg.moradorCasa, 300),
        receipt?.receiptNumber || null, receipt?.receiptHash || null, type, priority, title, description,
        openedAt, openedAt, publicActor.id, publicActor.name
      );
      appendOccurrenceEvent(database, id, {
        type: 'occurrence_opened',
        title: 'Ocorrência aberta pelo morador',
        description,
        occurredAt: openedAt,
        actor: publicActor,
        source: 'portal-morador',
        metadata: {
          occurrenceNumber,
          type,
          priority,
          packageId: String(pkg.id),
          packageCode: cleanText(pkg.codigo, 160),
          receiptNumber: receipt?.receiptNumber || null,
          origin: 'portal-morador',
          ip: publicActor.ip
        }
      });
      appendEvent(pkg, {
        type: 'occurrence_opened',
        title: 'Ocorrência aberta pelo morador',
        description: `Ocorrência ${occurrenceNumber} registrada pelo Portal do Morador.`,
        occurredAt: openedAt,
        recordedAt: openedAt,
        actor: publicActor.name,
        actorRole: 'morador',
        source: 'portal-morador',
        metadata: { occurrenceNumber, type, priority, origin: 'portal-morador' }
      });
      database.persistCustodyEvents([pkg]);
    });

    try {
      this.associations.writeMirror(association.id, this.associations.readState(association.id));
    } catch (_) {}
    return this.get(association.id, residentIds, id);
  }

  list(associationId, residentIds) {
    const { database } = this.database(associationId);
    const allowed = residentIdsSet(residentIds);
    const rows = database.db.prepare(`
      SELECT * FROM ${OCCURRENCE_TABLE}
      WHERE created_by_role = 'morador'
      ORDER BY opened_at DESC
    `).all().filter(row => allowed.has(String(row.resident_id || '')));
    return {
      occurrences: rows.map(residentOccurrence),
      summary: {
        total: rows.length,
        abertas: rows.filter(row => ACTIVE_STATUSES.has(String(row.status || ''))).length,
        concluidas: rows.filter(row => row.status === 'concluida').length
      }
    };
  }

  get(associationId, residentIds, idOrNumber) {
    const { database } = this.database(associationId);
    const row = database.db.prepare(`SELECT * FROM ${OCCURRENCE_TABLE} WHERE id = ? OR occurrence_number = ? LIMIT 1`)
      .get(String(idOrNumber || ''), String(idOrNumber || ''));
    this.assertOccurrenceOwnership(row, residentIds);
    const occurrence = residentOccurrence(row);
    const allEvents = readOccurrenceEvents(database, row.id);
    const integrity = verifyOccurrenceEvents(allEvents);
    if (!integrity.ok) fail('A linha do tempo desta ocorrência não passou na verificação de integridade.', 409);
    return {
      occurrence,
      timeline: residentTimeline(allEvents, occurrence),
      integrity: { status: 'ok', algorithm: 'sha256', eventCount: allEvents.length }
    };
  }

  addStatement(associationId, residentIds, idOrNumber, text, actor = {}) {
    const { association, database } = this.database(associationId);
    const row = database.db.prepare(`SELECT * FROM ${OCCURRENCE_TABLE} WHERE id = ? OR occurrence_number = ? LIMIT 1`)
      .get(String(idOrNumber || ''), String(idOrNumber || ''));
    this.assertOccurrenceOwnership(row, residentIds);
    if (!ACTIVE_STATUSES.has(String(row.status || ''))) fail('Esta ocorrência não está aberta para novas manifestações.', 409);
    const description = cleanText(text, 4000);
    if (description.length < 10) fail('A manifestação deve possuir pelo menos 10 caracteres.');
    const publicActor = actorPublic(actor);
    database.transaction(() => {
      appendOccurrenceEvent(database, row.id, {
        type: 'resident_statement',
        title: 'Manifestação do morador registrada',
        description,
        actor: publicActor,
        source: 'portal-morador',
        metadata: { origin: 'portal-morador', ip: publicActor.ip }
      });
    });
    try {
      this.associations.writeMirror(association.id, this.associations.readState(association.id));
    } catch (_) {}
    return this.get(association.id, residentIds, row.id);
  }

  status() {
    return {
      enabled: true,
      residentTypes: Object.keys(RESIDENT_TYPES),
      duplicateActiveBlocked: true,
      internalNotesExposed: false
    };
  }
}

module.exports = {
  ResidentOccurrenceService,
  RESIDENT_TYPES,
  ACTIVE_STATUSES,
  residentOccurrence,
  residentTimeline
};
