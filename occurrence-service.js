'use strict';

const crypto = require('crypto');
const { appendEvent } = require('./custody-chain');
const { receiptForPackage } = require('./withdrawal-receipt');

const OCCURRENCE_VERSION = 1;
const HASH_ALGORITHM = 'sha256';
const EMPTY_HASH = '0'.repeat(64);
const OCCURRENCE_TABLE = 'occurrences';
const EVENT_TABLE = 'occurrence_events';
const ATTACHMENT_TABLE = 'occurrence_attachments';
const SEQUENCE_TABLE = 'occurrence_sequences';
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENTS = 12;
const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;

const TYPES = Object.freeze({
  contestacao_retirada: 'Contestação de retirada',
  encomenda_danificada: 'Encomenda danificada',
  destinatario_incorreto: 'Destinatário incorreto',
  entrega_equivocada: 'Entrega equivocada',
  encomenda_nao_localizada: 'Encomenda não localizada',
  divergencia_transportadora: 'Divergência com transportadora',
  recusa_destinatario: 'Recusa do destinatário',
  suspeita_documental: 'Suspeita documental',
  outro: 'Outro'
});

const PRIORITIES = Object.freeze({
  baixa: 'Baixa',
  normal: 'Normal',
  alta: 'Alta',
  critica: 'Crítica'
});

const STATUSES = Object.freeze({
  aberta: 'Aberta',
  em_apuracao: 'Em apuração',
  aguardando_informacao: 'Aguardando informação',
  concluida: 'Concluída',
  cancelada: 'Cancelada'
});

const OUTCOMES = Object.freeze({
  entrega_confirmada: 'Entrega confirmada',
  erro_operacional_confirmado: 'Erro operacional confirmado',
  entrega_equivocada: 'Entrega equivocada',
  encomenda_localizada: 'Encomenda localizada',
  divergencia_resolvida: 'Divergência resolvida',
  responsabilidade_transportadora: 'Responsabilidade da transportadora',
  sem_elementos_suficientes: 'Sem elementos suficientes',
  outro: 'Outro'
});

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain'
]);

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    out[key] = stableValue(value[key]);
  }
  return out;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function cleanText(value, max = 1000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function safeFileName(value) {
  const name = cleanText(value, 160).replace(/[\\/]+/g, '_').replace(/[\r\n\t]/g, ' ');
  return name || 'anexo';
}

function actorPublic(actor = {}) {
  return {
    id: cleanText(actor.id, 120),
    name: cleanText(actor.name || actor.nome || 'PortalSync', 120),
    role: cleanText(actor.role || actor.perfil || 'sistema', 40)
  };
}

function requireActorRole(actor, roles) {
  const role = String(actor?.role || actor?.perfil || '');
  if (!roles.includes(role)) fail('Sem permissão para esta ação.', 403);
}

function ensureOccurrenceTables(database) {
  const db = database?.db;
  if (!db) fail('Banco SQLite indisponível para a Central de Ocorrências.', 503);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${OCCURRENCE_TABLE} (
      id TEXT PRIMARY KEY,
      occurrence_number TEXT NOT NULL UNIQUE,
      package_id TEXT NOT NULL,
      package_code TEXT,
      resident_id TEXT,
      resident_name TEXT,
      resident_house TEXT,
      receipt_number TEXT,
      receipt_hash TEXT,
      type TEXT NOT NULL,
      priority TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      outcome TEXT,
      conclusion TEXT,
      opened_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      created_by_id TEXT,
      created_by_name TEXT,
      created_by_role TEXT,
      last_event_hash TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_occurrence_package ON ${OCCURRENCE_TABLE}(package_id, opened_at);
    CREATE INDEX IF NOT EXISTS idx_occurrence_status ON ${OCCURRENCE_TABLE}(status, opened_at);
    CREATE INDEX IF NOT EXISTS idx_occurrence_priority ON ${OCCURRENCE_TABLE}(priority, opened_at);
    CREATE INDEX IF NOT EXISTS idx_occurrence_number ON ${OCCURRENCE_TABLE}(occurrence_number);

    CREATE TABLE IF NOT EXISTS ${EVENT_TABLE} (
      id TEXT PRIMARY KEY,
      occurrence_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      occurred_at TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_id TEXT,
      actor_name TEXT,
      actor_role TEXT,
      previous_hash TEXT NOT NULL,
      event_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE(occurrence_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_occurrence_events ON ${EVENT_TABLE}(occurrence_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_occurrence_events_time ON ${EVENT_TABLE}(occurred_at);

    CREATE TABLE IF NOT EXISTS ${ATTACHMENT_TABLE} (
      id TEXT PRIMARY KEY,
      occurrence_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      content BLOB NOT NULL,
      created_at TEXT NOT NULL,
      created_by_id TEXT,
      created_by_name TEXT,
      created_by_role TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_occurrence_attachments ON ${ATTACHMENT_TABLE}(occurrence_id, created_at);

    CREATE TABLE IF NOT EXISTS ${SEQUENCE_TABLE} (
      year INTEGER PRIMARY KEY,
      last_number INTEGER NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS occurrence_events_no_update
    BEFORE UPDATE ON ${EVENT_TABLE}
    BEGIN
      SELECT RAISE(ABORT, 'occurrence_events is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS occurrence_events_no_delete
    BEFORE DELETE ON ${EVENT_TABLE}
    BEGIN
      SELECT RAISE(ABORT, 'occurrence_events is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS occurrence_attachments_no_update
    BEFORE UPDATE ON ${ATTACHMENT_TABLE}
    BEGIN
      SELECT RAISE(ABORT, 'occurrence_attachments is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS occurrence_attachments_no_delete
    BEFORE DELETE ON ${ATTACHMENT_TABLE}
    BEGIN
      SELECT RAISE(ABORT, 'occurrence_attachments is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS occurrences_no_delete
    BEFORE DELETE ON ${OCCURRENCE_TABLE}
    BEGIN
      SELECT RAISE(ABORT, 'occurrences cannot be deleted');
    END;
  `);
}

function allocateOccurrenceNumber(database, year) {
  ensureOccurrenceTables(database);
  const db = database.db;
  const targetYear = Number(year);
  db.exec('BEGIN IMMEDIATE;');
  try {
    let row = db.prepare(`SELECT last_number FROM ${SEQUENCE_TABLE} WHERE year = ?`).get(targetYear);
    if (!row) {
      const prefix = `OC-${targetYear}-`;
      const latest = db.prepare(`SELECT occurrence_number FROM ${OCCURRENCE_TABLE} WHERE occurrence_number LIKE ? ORDER BY occurrence_number DESC LIMIT 1`).get(prefix + '%');
      const existing = latest ? Number(String(latest.occurrence_number).split('-').at(-1)) || 0 : 0;
      db.prepare(`INSERT INTO ${SEQUENCE_TABLE}(year, last_number) VALUES(?, ?)`).run(targetYear, existing);
      row = { last_number: existing };
    }
    const next = Number(row.last_number || 0) + 1;
    db.prepare(`UPDATE ${SEQUENCE_TABLE} SET last_number = ? WHERE year = ?`).run(next, targetYear);
    db.exec('COMMIT;');
    return `OC-${targetYear}-${String(next).padStart(6, '0')}`;
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch (_) {}
    throw error;
  }
}

function eventCanonical(event) {
  return {
    version: Number(event?.version || OCCURRENCE_VERSION),
    occurrenceId: String(event?.occurrenceId || ''),
    seq: Number(event?.seq || 0),
    id: String(event?.id || ''),
    occurredAt: String(event?.occurredAt || ''),
    type: String(event?.type || ''),
    title: String(event?.title || ''),
    description: String(event?.description || ''),
    actor: actorPublic(event?.actor || {}),
    source: String(event?.source || 'central-ocorrencias'),
    metadata: stableValue(event?.metadata || {}),
    previousHash: String(event?.previousHash || EMPTY_HASH)
  };
}

function hashOccurrenceEvent(event) {
  return crypto.createHash(HASH_ALGORITHM).update(stableStringify(eventCanonical(event))).digest('hex');
}

function readOccurrenceEvents(database, occurrenceId) {
  ensureOccurrenceTables(database);
  const rows = database.db.prepare(`SELECT payload_json FROM ${EVENT_TABLE} WHERE occurrence_id = ? ORDER BY sequence ASC`).all(String(occurrenceId));
  return rows.map(row => {
    try { return JSON.parse(row.payload_json); } catch (_) { return null; }
  }).filter(Boolean);
}

function verifyOccurrenceEvents(events) {
  let previousHash = EMPTY_HASH;
  for (let index = 0; index < (events || []).length; index++) {
    const event = events[index];
    if (Number(event.seq) !== index + 1) return { ok:false, index, reason:'sequence' };
    if (String(event.previousHash || EMPTY_HASH) !== previousHash) return { ok:false, index, reason:'previous-hash' };
    const expected = hashOccurrenceEvent(event);
    if (String(event.hash || '') !== expected) return { ok:false, index, reason:'hash' };
    previousHash = expected;
  }
  return { ok:true, count:(events || []).length, lastHash:previousHash };
}

function appendOccurrenceEvent(database, occurrenceId, spec = {}) {
  ensureOccurrenceTables(database);
  const db = database.db;
  const last = db.prepare(`SELECT sequence, event_hash FROM ${EVENT_TABLE} WHERE occurrence_id = ? ORDER BY sequence DESC LIMIT 1`).get(String(occurrenceId));
  const seq = Number(last?.sequence || 0) + 1;
  const previousHash = String(last?.event_hash || EMPTY_HASH);
  const event = {
    version: OCCURRENCE_VERSION,
    occurrenceId: String(occurrenceId),
    seq,
    id: `oc-event-${String(occurrenceId)}-${seq}-${crypto.randomBytes(4).toString('hex')}`,
    occurredAt: String(spec.occurredAt || new Date().toISOString()),
    type: cleanText(spec.type || 'note', 80),
    title: cleanText(spec.title || 'Registro da ocorrência', 160),
    description: cleanText(spec.description || '', 4000),
    actor: actorPublic(spec.actor),
    source: cleanText(spec.source || 'central-ocorrencias', 80),
    metadata: stableValue(spec.metadata || {}),
    previousHash
  };
  event.hash = hashOccurrenceEvent(event);
  db.prepare(`
    INSERT INTO ${EVENT_TABLE}(id, occurrence_id, sequence, occurred_at, event_type, actor_id, actor_name, actor_role, previous_hash, event_hash, payload_json)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id, event.occurrenceId, event.seq, event.occurredAt, event.type,
    event.actor.id, event.actor.name, event.actor.role, event.previousHash, event.hash, JSON.stringify(event)
  );
  db.prepare(`UPDATE ${OCCURRENCE_TABLE} SET updated_at = ?, last_event_hash = ? WHERE id = ?`)
    .run(event.occurredAt, event.hash, String(occurrenceId));
  return event;
}

function occurrenceRow(database, idOrNumber) {
  ensureOccurrenceTables(database);
  return database.db.prepare(`SELECT * FROM ${OCCURRENCE_TABLE} WHERE id = ? OR occurrence_number = ? LIMIT 1`)
    .get(String(idOrNumber || ''), String(idOrNumber || '')) || null;
}

function rowPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    number: row.occurrence_number,
    occurrenceNumber: row.occurrence_number,
    packageId: row.package_id,
    packageCode: row.package_code || '',
    residentId: row.resident_id || '',
    residentName: row.resident_name || '',
    residentHouse: row.resident_house || '',
    receiptNumber: row.receipt_number || null,
    receiptHash: row.receipt_hash || null,
    type: row.type,
    typeLabel: TYPES[row.type] || row.type,
    priority: row.priority,
    priorityLabel: PRIORITIES[row.priority] || row.priority,
    status: row.status,
    statusLabel: STATUSES[row.status] || row.status,
    title: row.title,
    description: row.description,
    outcome: row.outcome || null,
    outcomeLabel: row.outcome ? (OUTCOMES[row.outcome] || row.outcome) : null,
    conclusion: row.conclusion || null,
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at || null,
    createdBy: {
      id: row.created_by_id || '',
      name: row.created_by_name || '',
      role: row.created_by_role || ''
    },
    lastEventHash: row.last_event_hash || null
  };
}

function attachmentMeta(row) {
  return row ? {
    id: row.id,
    occurrenceId: row.occurrence_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes || 0),
    sha256: row.sha256,
    createdAt: row.created_at,
    createdBy: { id:row.created_by_id || '', name:row.created_by_name || '', role:row.created_by_role || '' }
  } : null;
}

function listAttachments(database, occurrenceId) {
  ensureOccurrenceTables(database);
  return database.db.prepare(`
    SELECT id, occurrence_id, file_name, mime_type, size_bytes, sha256, created_at, created_by_id, created_by_name, created_by_role
    FROM ${ATTACHMENT_TABLE} WHERE occurrence_id = ? ORDER BY created_at ASC
  `).all(String(occurrenceId)).map(attachmentMeta);
}

function normalizeBase64(value) {
  const text = String(value || '').replace(/\s+/g, '');
  if (!text || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) fail('Conteúdo do anexo inválido.');
  return text;
}

class OccurrenceService {
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

  packageState(associationId, packageId) {
    const state = this.associations.readState(associationId);
    const pkg = (state.encomendas || []).find(item => String(item?.id || '') === String(packageId || ''));
    if (!pkg) fail('Encomenda não localizada nesta associação.', 404);
    return { state, pkg };
  }

  linkPackageCustody(database, pkg, spec) {
    appendEvent(pkg, {
      type: spec.type,
      title: spec.title,
      description: spec.description,
      occurredAt: spec.occurredAt || this.now(),
      recordedAt: spec.occurredAt || this.now(),
      actor: spec.actor?.name || spec.actor?.nome || 'PortalSync',
      actorRole: spec.actor?.role || spec.actor?.perfil || 'sistema',
      source: 'central-ocorrencias',
      metadata: spec.metadata || {}
    });
    database.persistCustodyEvents([pkg]);
  }

  syncMirror(associationId) {
    try {
      const state = this.associations.readState(associationId);
      this.associations.writeMirror(associationId, state);
    } catch (_) {}
  }

  create(associationId, input = {}, actor = {}) {
    requireActorRole(actor, ['admin', 'supervisor', 'porteiro']);
    const { association, database } = this.database(associationId);
    const packageId = cleanText(input.packageId, 160);
    if (!packageId) fail('Selecione a encomenda relacionada.');
    const { state, pkg } = this.packageState(association.id, packageId);
    const type = cleanText(input.type, 80);
    if (!TYPES[type]) fail('Tipo de ocorrência inválido.');
    const priority = cleanText(input.priority || 'normal', 40);
    if (!PRIORITIES[priority]) fail('Prioridade inválida.');
    const description = cleanText(input.description, 4000);
    if (description.length < 10) fail('Descreva a ocorrência com pelo menos 10 caracteres.');
    const title = cleanText(input.title || TYPES[type], 160) || TYPES[type];
    const now = this.now();
    const openedAt = now.toISOString();
    const occurrenceNumber = allocateOccurrenceNumber(database, now.getUTCFullYear());
    const id = 'oc-' + crypto.randomBytes(12).toString('hex');
    const receipt = receiptForPackage(database, pkg.id);
    const publicActor = actorPublic(actor);

    database.transaction(() => {
      database.db.prepare(`
        INSERT INTO ${OCCURRENCE_TABLE}(
          id, occurrence_number, package_id, package_code, resident_id, resident_name, resident_house,
          receipt_number, receipt_hash, type, priority, status, title, description, outcome, conclusion,
          opened_at, updated_at, closed_at, created_by_id, created_by_name, created_by_role, last_event_hash
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aberta', ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?, NULL)
      `).run(
        id, occurrenceNumber, String(pkg.id), cleanText(pkg.codigo, 160), cleanText(pkg.moradorId, 160),
        cleanText(pkg.moradorNome, 200), cleanText(pkg.moradorCasa, 300),
        receipt?.receiptNumber || null, receipt?.receiptHash || null, type, priority, title, description,
        openedAt, openedAt, publicActor.id, publicActor.name, publicActor.role
      );
      appendOccurrenceEvent(database, id, {
        type:'occurrence_opened',
        title:'Ocorrência aberta',
        description,
        occurredAt:openedAt,
        actor,
        metadata:{ occurrenceNumber, type, priority, packageId:String(pkg.id), packageCode:cleanText(pkg.codigo,160), receiptNumber:receipt?.receiptNumber || null, ip:cleanText(actor.ip,120) }
      });
      this.linkPackageCustody(database, pkg, {
        type:'occurrence_opened',
        title:'Ocorrência administrativa aberta',
        description:`Ocorrência ${occurrenceNumber} aberta para esta encomenda.`,
        occurredAt:openedAt,
        actor,
        metadata:{ occurrenceNumber, type, priority }
      });
    });
    this.syncMirror(association.id);
    return this.get(association.id, id);
  }

  list(associationId, filters = {}) {
    const { database } = this.database(associationId);
    const where = [];
    const params = [];
    if (filters.status && STATUSES[filters.status]) { where.push('status = ?'); params.push(filters.status); }
    if (filters.priority && PRIORITIES[filters.priority]) { where.push('priority = ?'); params.push(filters.priority); }
    if (filters.type && TYPES[filters.type]) { where.push('type = ?'); params.push(filters.type); }
    if (filters.packageId) { where.push('package_id = ?'); params.push(String(filters.packageId)); }
    if (filters.q) {
      const q = '%' + String(filters.q).slice(0,120) + '%';
      where.push('(occurrence_number LIKE ? OR package_code LIKE ? OR resident_name LIKE ? OR title LIKE ?)');
      params.push(q, q, q, q);
    }
    const sql = `SELECT * FROM ${OCCURRENCE_TABLE}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY opened_at DESC`;
    const occurrences = database.db.prepare(sql).all(...params).map(rowPublic);
    return { occurrences, metrics:this.metrics(associationId) };
  }

  metrics(associationId) {
    const { database } = this.database(associationId);
    const db = database.db;
    const total = Number(db.prepare(`SELECT COUNT(*) total FROM ${OCCURRENCE_TABLE}`).get()?.total || 0);
    const opened = Number(db.prepare(`SELECT COUNT(*) total FROM ${OCCURRENCE_TABLE} WHERE status IN ('aberta','em_apuracao','aguardando_informacao')`).get()?.total || 0);
    const inProgress = Number(db.prepare(`SELECT COUNT(*) total FROM ${OCCURRENCE_TABLE} WHERE status = 'em_apuracao'`).get()?.total || 0);
    const critical = Number(db.prepare(`SELECT COUNT(*) total FROM ${OCCURRENCE_TABLE} WHERE priority = 'critica' AND status NOT IN ('concluida','cancelada')`).get()?.total || 0);
    const concluded = Number(db.prepare(`SELECT COUNT(*) total FROM ${OCCURRENCE_TABLE} WHERE status = 'concluida'`).get()?.total || 0);
    return { total, opened, inProgress, critical, concluded };
  }

  get(associationId, idOrNumber) {
    const { database } = this.database(associationId);
    const row = occurrenceRow(database, idOrNumber);
    if (!row) fail('Ocorrência não localizada.', 404);
    const events = readOccurrenceEvents(database, row.id);
    const integrity = verifyOccurrenceEvents(events);
    return {
      occurrence: rowPublic(row),
      events,
      attachments: listAttachments(database, row.id),
      integrity:{ algorithm:HASH_ALGORITHM, appendOnly:true, status:integrity.ok ? 'ok' : 'error', eventCount:events.length, lastHash:integrity.lastHash || null }
    };
  }

  addNote(associationId, idOrNumber, input = {}, actor = {}) {
    requireActorRole(actor, ['admin', 'supervisor', 'porteiro']);
    const { association, database } = this.database(associationId);
    const row = occurrenceRow(database, idOrNumber);
    if (!row) fail('Ocorrência não localizada.', 404);
    const kind = input.kind === 'resident_statement' ? 'resident_statement' : 'administrative_note';
    const text = cleanText(input.text, 4000);
    if (text.length < 5) fail('Informe um registro com pelo menos 5 caracteres.');
    database.transaction(() => {
      appendOccurrenceEvent(database, row.id, {
        type:kind,
        title:kind === 'resident_statement' ? 'Manifestação do morador registrada' : 'Nota administrativa registrada',
        description:text,
        actor,
        metadata:{ ip:cleanText(actor.ip,120) }
      });
    });
    this.syncMirror(association.id);
    return this.get(association.id, row.id);
  }

  setPriority(associationId, idOrNumber, priority, actor = {}) {
    requireActorRole(actor, ['admin', 'supervisor']);
    if (!PRIORITIES[priority]) fail('Prioridade inválida.');
    const { association, database } = this.database(associationId);
    const row = occurrenceRow(database, idOrNumber);
    if (!row) fail('Ocorrência não localizada.', 404);
    if (row.priority === priority) return this.get(association.id, row.id);
    database.transaction(() => {
      database.db.prepare(`UPDATE ${OCCURRENCE_TABLE} SET priority = ?, updated_at = ? WHERE id = ?`).run(priority, this.now().toISOString(), row.id);
      appendOccurrenceEvent(database, row.id, {
        type:'priority_changed', title:'Prioridade alterada',
        description:`Prioridade alterada de ${PRIORITIES[row.priority] || row.priority} para ${PRIORITIES[priority]}.`, actor,
        metadata:{ previous:row.priority, current:priority, ip:cleanText(actor.ip,120) }
      });
    });
    return this.get(association.id, row.id);
  }

  setStatus(associationId, idOrNumber, status, reason, actor = {}) {
    requireActorRole(actor, ['admin', 'supervisor']);
    if (!['aberta','em_apuracao','aguardando_informacao'].includes(status)) fail('Use as ações específicas para concluir, cancelar ou reabrir a ocorrência.');
    const { association, database } = this.database(associationId);
    const row = occurrenceRow(database, idOrNumber);
    if (!row) fail('Ocorrência não localizada.', 404);
    if (['concluida','cancelada'].includes(row.status)) fail('A ocorrência precisa ser reaberta antes de alterar o andamento.', 409);
    if (row.status === status) return this.get(association.id, row.id);
    const note = cleanText(reason, 1000);
    database.transaction(() => {
      database.db.prepare(`UPDATE ${OCCURRENCE_TABLE} SET status = ?, updated_at = ? WHERE id = ?`).run(status, this.now().toISOString(), row.id);
      appendOccurrenceEvent(database, row.id, {
        type:'status_changed', title:'Status alterado',
        description:`Status alterado de ${STATUSES[row.status] || row.status} para ${STATUSES[status]}.${note ? ' Motivo: ' + note : ''}`, actor,
        metadata:{ previous:row.status, current:status, ip:cleanText(actor.ip,120) }
      });
    });
    return this.get(association.id, row.id);
  }

  conclude(associationId, idOrNumber, input = {}, actor = {}) {
    requireActorRole(actor, ['admin']);
    const outcome = cleanText(input.outcome, 80);
    if (!OUTCOMES[outcome]) fail('Resultado da apuração inválido.');
    const conclusion = cleanText(input.conclusion, 5000);
    if (conclusion.length < 20) fail('A conclusão deve possuir pelo menos 20 caracteres.');
    const { association, database } = this.database(associationId);
    const row = occurrenceRow(database, idOrNumber);
    if (!row) fail('Ocorrência não localizada.', 404);
    if (row.status === 'concluida') return this.get(association.id, row.id);
    if (row.status === 'cancelada') fail('Reabra a ocorrência antes de concluí-la.', 409);
    const { pkg } = this.packageState(association.id, row.package_id);
    const closedAt = this.now().toISOString();
    database.transaction(() => {
      database.db.prepare(`UPDATE ${OCCURRENCE_TABLE} SET status='concluida', outcome=?, conclusion=?, closed_at=?, updated_at=? WHERE id=?`)
        .run(outcome, conclusion, closedAt, closedAt, row.id);
      appendOccurrenceEvent(database, row.id, {
        type:'occurrence_concluded', title:'Ocorrência concluída', description:conclusion, occurredAt:closedAt, actor,
        metadata:{ outcome, outcomeLabel:OUTCOMES[outcome], ip:cleanText(actor.ip,120) }
      });
      this.linkPackageCustody(database, pkg, {
        type:'occurrence_concluded', title:'Ocorrência administrativa concluída',
        description:`Ocorrência ${row.occurrence_number} concluída: ${OUTCOMES[outcome]}.`, occurredAt:closedAt, actor,
        metadata:{ occurrenceNumber:row.occurrence_number, outcome }
      });
    });
    this.syncMirror(association.id);
    return this.get(association.id, row.id);
  }

  reopen(associationId, idOrNumber, reason, actor = {}) {
    requireActorRole(actor, ['admin']);
    const text = cleanText(reason, 3000);
    if (text.length < 20) fail('Informe o motivo da reabertura com pelo menos 20 caracteres.');
    const { association, database } = this.database(associationId);
    const row = occurrenceRow(database, idOrNumber);
    if (!row) fail('Ocorrência não localizada.', 404);
    if (!['concluida','cancelada'].includes(row.status)) fail('Somente ocorrência concluída ou cancelada pode ser reaberta.', 409);
    const { pkg } = this.packageState(association.id, row.package_id);
    const at = this.now().toISOString();
    database.transaction(() => {
      database.db.prepare(`UPDATE ${OCCURRENCE_TABLE} SET status='em_apuracao', outcome=NULL, conclusion=NULL, closed_at=NULL, updated_at=? WHERE id=?`).run(at, row.id);
      appendOccurrenceEvent(database, row.id, {
        type:'occurrence_reopened', title:'Ocorrência reaberta', description:text, occurredAt:at, actor,
        metadata:{ previousStatus:row.status, ip:cleanText(actor.ip,120) }
      });
      this.linkPackageCustody(database, pkg, {
        type:'occurrence_reopened', title:'Ocorrência administrativa reaberta',
        description:`Ocorrência ${row.occurrence_number} reaberta para nova apuração.`, occurredAt:at, actor,
        metadata:{ occurrenceNumber:row.occurrence_number }
      });
    });
    this.syncMirror(association.id);
    return this.get(association.id, row.id);
  }

  cancel(associationId, idOrNumber, reason, actor = {}) {
    requireActorRole(actor, ['admin']);
    const text = cleanText(reason, 3000);
    if (text.length < 20) fail('Informe o motivo do cancelamento com pelo menos 20 caracteres.');
    const { association, database } = this.database(associationId);
    const row = occurrenceRow(database, idOrNumber);
    if (!row) fail('Ocorrência não localizada.', 404);
    if (row.status === 'concluida') fail('Reabra a ocorrência antes de cancelá-la.', 409);
    if (row.status === 'cancelada') return this.get(association.id, row.id);
    const { pkg } = this.packageState(association.id, row.package_id);
    const at = this.now().toISOString();
    database.transaction(() => {
      database.db.prepare(`UPDATE ${OCCURRENCE_TABLE} SET status='cancelada', conclusion=?, closed_at=?, updated_at=? WHERE id=?`).run(text, at, at, row.id);
      appendOccurrenceEvent(database, row.id, {
        type:'occurrence_cancelled', title:'Ocorrência cancelada', description:text, occurredAt:at, actor,
        metadata:{ ip:cleanText(actor.ip,120) }
      });
      this.linkPackageCustody(database, pkg, {
        type:'occurrence_cancelled', title:'Ocorrência administrativa cancelada',
        description:`Ocorrência ${row.occurrence_number} cancelada, sem exclusão do histórico.`, occurredAt:at, actor,
        metadata:{ occurrenceNumber:row.occurrence_number }
      });
    });
    this.syncMirror(association.id);
    return this.get(association.id, row.id);
  }

  addAttachment(associationId, idOrNumber, input = {}, actor = {}) {
    requireActorRole(actor, ['admin', 'supervisor', 'porteiro']);
    const { association, database } = this.database(associationId);
    const row = occurrenceRow(database, idOrNumber);
    if (!row) fail('Ocorrência não localizada.', 404);
    const mimeType = cleanText(input.mimeType, 100).toLowerCase();
    if (!ALLOWED_MIME.has(mimeType)) fail('Tipo de arquivo não permitido. Use JPG, PNG, WEBP, PDF ou TXT.');
    const fileName = safeFileName(input.fileName);
    const base64 = normalizeBase64(input.base64);
    const content = Buffer.from(base64, 'base64');
    if (!content.length) fail('O anexo está vazio.');
    if (content.length > MAX_ATTACHMENT_BYTES) fail('Cada anexo pode ter no máximo 2 MB.');
    const usage = database.db.prepare(`SELECT COUNT(*) total, COALESCE(SUM(size_bytes),0) bytes FROM ${ATTACHMENT_TABLE} WHERE occurrence_id = ?`).get(row.id);
    if (Number(usage?.total || 0) >= MAX_ATTACHMENTS) fail(`Limite de ${MAX_ATTACHMENTS} anexos atingido.`, 409);
    if (Number(usage?.bytes || 0) + content.length > MAX_TOTAL_ATTACHMENT_BYTES) fail('O conjunto de anexos desta ocorrência atingiu o limite de 12 MB.', 409);
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    const id = 'oc-att-' + crypto.randomBytes(12).toString('hex');
    const at = this.now().toISOString();
    const publicActor = actorPublic(actor);
    database.transaction(() => {
      database.db.prepare(`
        INSERT INTO ${ATTACHMENT_TABLE}(id, occurrence_id, file_name, mime_type, size_bytes, sha256, content, created_at, created_by_id, created_by_name, created_by_role)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, row.id, fileName, mimeType, content.length, sha256, content, at, publicActor.id, publicActor.name, publicActor.role);
      appendOccurrenceEvent(database, row.id, {
        type:'attachment_added', title:'Evidência anexada', description:`Arquivo ${fileName} anexado à apuração.`, occurredAt:at, actor,
        metadata:{ attachmentId:id, fileName, mimeType, sizeBytes:content.length, sha256, ip:cleanText(actor.ip,120) }
      });
    });
    return this.get(association.id, row.id);
  }

  getAttachment(associationId, idOrNumber, attachmentId) {
    const { database } = this.database(associationId);
    const row = occurrenceRow(database, idOrNumber);
    if (!row) fail('Ocorrência não localizada.', 404);
    const attachment = database.db.prepare(`SELECT * FROM ${ATTACHMENT_TABLE} WHERE occurrence_id = ? AND id = ? LIMIT 1`).get(row.id, String(attachmentId || ''));
    if (!attachment) fail('Anexo não localizado.', 404);
    const content = Buffer.isBuffer(attachment.content) ? attachment.content : Buffer.from(attachment.content || []);
    const actual = crypto.createHash('sha256').update(content).digest('hex');
    if (actual !== attachment.sha256) fail('Integridade do anexo comprometida.', 409);
    return { ...attachmentMeta(attachment), content, integrity:'ok' };
  }

  status(associationId) {
    const { database } = this.database(associationId);
    const metrics = this.metrics(associationId);
    const eventCount = Number(database.db.prepare(`SELECT COUNT(*) total FROM ${EVENT_TABLE}`).get()?.total || 0);
    const attachmentCount = Number(database.db.prepare(`SELECT COUNT(*) total FROM ${ATTACHMENT_TABLE}`).get()?.total || 0);
    return { enabled:true, appendOnlyTimeline:true, hashAlgorithm:HASH_ALGORITHM, ...metrics, events:eventCount, attachments:attachmentCount };
  }
}

module.exports = {
  OccurrenceService,
  OCCURRENCE_VERSION,
  HASH_ALGORITHM,
  EMPTY_HASH,
  OCCURRENCE_TABLE,
  EVENT_TABLE,
  ATTACHMENT_TABLE,
  SEQUENCE_TABLE,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_TOTAL_ATTACHMENT_BYTES,
  TYPES,
  PRIORITIES,
  STATUSES,
  OUTCOMES,
  ALLOWED_MIME,
  ensureOccurrenceTables,
  allocateOccurrenceNumber,
  eventCanonical,
  hashOccurrenceEvent,
  readOccurrenceEvents,
  verifyOccurrenceEvents,
  appendOccurrenceEvent,
  rowPublic,
  listAttachments,
  cleanText,
  safeFileName
};
