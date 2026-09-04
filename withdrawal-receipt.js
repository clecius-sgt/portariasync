'use strict';

const crypto = require('crypto');
const { appendEvent, verifyChain } = require('./custody-chain');

const RECEIPT_VERSION = 1;
const HASH_ALGORITHM = 'sha256';
const RECEIPT_EVENT = 'withdrawal_receipt_issued';
const RECEIPT_TABLE = 'withdrawal_receipts';
const SEQUENCE_TABLE = 'withdrawal_receipt_sequences';

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

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function maskDocument(value) {
  const clean = String(value || '').trim();
  const compact = clean.replace(/\s+/g, '');
  if (!compact) return '';
  const tail = compact.slice(-4);
  return '***' + tail;
}

function latestCustodyHash(pkg) {
  const chain = Array.isArray(pkg?.cadeiaCustodia) ? pkg.cadeiaCustodia : [];
  if (!chain.length) return '';
  const integrity = verifyChain(pkg);
  if (!integrity.ok) throw new Error('A cadeia de custódia precisa estar íntegra antes da emissão do comprovante.');
  return String(integrity.lastHash || chain.at(-1)?.hash || '');
}

function latestWithdrawalAudit(state, packageId) {
  const id = String(packageId || '');
  const audits = Array.isArray(state?.auditoria) ? state.auditoria : [];
  const matches = audits.filter(item => {
    const details = item?.detalhes || item || {};
    const eventPackage = String(details.encomendaId || details.packageId || '');
    const action = String(item?.acao || item?.action || '').toLowerCase();
    return eventPackage === id && action.includes('retirada');
  });
  return matches.at(-1) || null;
}

function validationInfo(pkg) {
  const method = String(pkg?.pinRetiradaMetodo || '').toLowerCase();
  if (method === 'pin') return { code: 'pin', label: 'PIN de retirada validado' };
  if (method === 'autorizacao-digital') return { code: 'autorizacao-digital', label: 'Autorização digital de terceiro validada' };
  if (method === 'liberacao-administrativa') return { code: 'liberacao-administrativa', label: 'Liberação administrativa registrada' };
  if (String(pkg?.retiranteTipo || '').toLowerCase() === 'outro') {
    return { code: 'identificacao-terceiro', label: 'Identificação do terceiro, evidência e assinatura registradas' };
  }
  return { code: 'identificacao-assinatura', label: 'Identificação e assinatura registradas' };
}

function receiptReady(pkg) {
  if (!pkg || pkg.status !== 'retirado' || !pkg.dataRetirada) return false;
  // Quando houve envio de PIN, aguarda o wrapper de validação concluir e gravar o método.
  // Isso evita emitir um comprovante antes do último controle de segurança da retirada.
  if (pkg.pinRetiradaEnviado === true && !String(pkg.pinRetiradaMetodo || '').trim()) return false;
  return true;
}

function receiptCanonical(receipt) {
  return {
    version: Number(receipt?.version || RECEIPT_VERSION),
    receiptNumber: String(receipt?.receiptNumber || ''),
    association: {
      id: String(receipt?.association?.id || ''),
      name: String(receipt?.association?.name || '')
    },
    package: {
      id: String(receipt?.package?.id || ''),
      code: String(receipt?.package?.code || ''),
      carrier: String(receipt?.package?.carrier || ''),
      residentId: String(receipt?.package?.residentId || ''),
      residentName: String(receipt?.package?.residentName || ''),
      residentHouse: String(receipt?.package?.residentHouse || ''),
      entryAt: String(receipt?.package?.entryAt || '')
    },
    withdrawal: {
      at: String(receipt?.withdrawal?.at || ''),
      person: String(receipt?.withdrawal?.person || ''),
      type: String(receipt?.withdrawal?.type || ''),
      documentMasked: String(receipt?.withdrawal?.documentMasked || ''),
      operator: String(receipt?.withdrawal?.operator || ''),
      validationCode: String(receipt?.withdrawal?.validationCode || ''),
      validationLabel: String(receipt?.withdrawal?.validationLabel || ''),
      signaturePresent: receipt?.withdrawal?.signaturePresent === true,
      photoEvidencePresent: receipt?.withdrawal?.photoEvidencePresent === true,
      administrativeOverride: receipt?.withdrawal?.administrativeOverride === true
    },
    custody: {
      algorithm: 'sha256',
      referenceHash: String(receipt?.custody?.referenceHash || '')
    },
    issuedAt: String(receipt?.issuedAt || ''),
    status: String(receipt?.status || 'ativo')
  };
}

function hashReceipt(receipt) {
  return crypto.createHash(HASH_ALGORITHM).update(stableStringify(receiptCanonical(receipt))).digest('hex');
}

function verifyReceipt(receipt) {
  if (!receipt || !receipt.receiptHash) return { ok: false, reason: 'missing-hash' };
  const expected = hashReceipt(receipt);
  return {
    ok: crypto.timingSafeEqual(Buffer.from(String(receipt.receiptHash), 'utf8'), Buffer.from(expected, 'utf8')),
    expected
  };
}

function buildReceipt({ association, pkg, state, receiptNumber, issuedAt = new Date().toISOString() }) {
  if (!receiptReady(pkg)) throw new Error('A retirada ainda não está pronta para emissão do comprovante.');
  const validation = validationInfo(pkg);
  const audit = latestWithdrawalAudit(state, pkg.id);
  const receipt = {
    version: RECEIPT_VERSION,
    receiptNumber: String(receiptNumber),
    association: {
      id: String(association?.id || ''),
      name: String(association?.name || association?.nome || 'Associação de Moradores')
    },
    package: {
      id: String(pkg.id),
      code: String(pkg.codigo || ''),
      carrier: String(pkg.transportadora || ''),
      residentId: String(pkg.moradorId || ''),
      residentName: String(pkg.moradorNome || ''),
      residentHouse: String(pkg.moradorCasa || ''),
      entryAt: String(pkg.dataEntrada || '')
    },
    withdrawal: {
      at: String(pkg.dataRetirada || ''),
      person: String(pkg.retiradoPor || pkg.moradorNome || ''),
      type: String(pkg.retiranteTipo || 'proprio'),
      documentMasked: String(pkg.retiranteTipo || '') === 'outro' ? maskDocument(pkg.retiranteRg) : '',
      operator: String(audit?.usuarioNome || audit?.usuario || audit?.userName || 'PortalSync'),
      validationCode: validation.code,
      validationLabel: validation.label,
      signaturePresent: !!pkg.assinatura,
      photoEvidencePresent: !!pkg.fotoRetirante,
      administrativeOverride: String(pkg.pinRetiradaMetodo || '') === 'liberacao-administrativa'
    },
    custody: {
      algorithm: HASH_ALGORITHM,
      referenceHash: latestCustodyHash(pkg)
    },
    issuedAt: String(issuedAt),
    status: 'ativo'
  };
  receipt.receiptHash = hashReceipt(receipt);
  receipt.integrity = 'ok';
  return receipt;
}

function ensureReceiptTables(database) {
  const db = database?.db;
  if (!db) throw new Error('Banco SQLite indisponível para os comprovantes de retirada.');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${RECEIPT_TABLE} (
      id TEXT PRIMARY KEY,
      receipt_number TEXT NOT NULL UNIQUE,
      package_id TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      receipt_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_withdrawal_receipts_package ON ${RECEIPT_TABLE}(package_id, issued_at);
    CREATE INDEX IF NOT EXISTS idx_withdrawal_receipts_issued ON ${RECEIPT_TABLE}(issued_at);

    CREATE TABLE IF NOT EXISTS ${SEQUENCE_TABLE} (
      year INTEGER PRIMARY KEY,
      last_number INTEGER NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS withdrawal_receipts_no_update
    BEFORE UPDATE ON ${RECEIPT_TABLE}
    BEGIN
      SELECT RAISE(ABORT, 'withdrawal_receipts is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS withdrawal_receipts_no_delete
    BEFORE DELETE ON ${RECEIPT_TABLE}
    BEGIN
      SELECT RAISE(ABORT, 'withdrawal_receipts is append-only');
    END;
  `);
}

function rowToReceipt(row) {
  if (!row) return null;
  try {
    const receipt = JSON.parse(row.payload_json);
    const check = verifyReceipt(receipt);
    return { ...receipt, integrity: check.ok ? 'ok' : 'error' };
  } catch (_) {
    return null;
  }
}

function receiptForPackage(database, packageId) {
  ensureReceiptTables(database);
  const row = database.db.prepare(`
    SELECT payload_json FROM ${RECEIPT_TABLE}
    WHERE package_id = ? ORDER BY issued_at DESC LIMIT 1
  `).get(String(packageId || ''));
  return rowToReceipt(row);
}

function receiptCount(database) {
  ensureReceiptTables(database);
  return Number(database.db.prepare(`SELECT COUNT(*) AS total FROM ${RECEIPT_TABLE}`).get()?.total || 0);
}

function allocateReceiptNumber(database, year) {
  ensureReceiptTables(database);
  const db = database.db;
  const targetYear = Number(year);
  db.exec('BEGIN IMMEDIATE;');
  try {
    let row = db.prepare(`SELECT last_number FROM ${SEQUENCE_TABLE} WHERE year = ?`).get(targetYear);
    if (!row) {
      const prefix = `RET-${targetYear}-`;
      const latest = db.prepare(`
        SELECT receipt_number FROM ${RECEIPT_TABLE}
        WHERE receipt_number LIKE ? ORDER BY receipt_number DESC LIMIT 1
      `).get(prefix + '%');
      const existing = latest ? Number(String(latest.receipt_number).split('-').at(-1)) || 0 : 0;
      db.prepare(`INSERT INTO ${SEQUENCE_TABLE}(year, last_number) VALUES(?, ?)`).run(targetYear, existing);
      row = { last_number: existing };
    }
    const next = Number(row.last_number || 0) + 1;
    db.prepare(`UPDATE ${SEQUENCE_TABLE} SET last_number = ? WHERE year = ?`).run(next, targetYear);
    db.exec('COMMIT;');
    return `RET-${targetYear}-${String(next).padStart(6, '0')}`;
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch (_) {}
    throw error;
  }
}

function insertReceipt(database, receipt) {
  ensureReceiptTables(database);
  const existing = receiptForPackage(database, receipt?.package?.id);
  if (existing) return existing;
  const id = 'ret-' + crypto.createHash('sha256').update(String(receipt.receiptNumber)).digest('hex').slice(0, 24);
  database.db.prepare(`
    INSERT INTO ${RECEIPT_TABLE}(id, receipt_number, package_id, issued_at, receipt_hash, payload_json)
    VALUES(?, ?, ?, ?, ?, ?)
  `).run(
    id,
    String(receipt.receiptNumber),
    String(receipt.package.id),
    String(receipt.issuedAt),
    String(receipt.receiptHash),
    JSON.stringify(receipt)
  );
  return receipt;
}

function hasReceiptEvent(pkg, receiptNumber) {
  return (Array.isArray(pkg?.cadeiaCustodia) ? pkg.cadeiaCustodia : []).some(event =>
    event?.type === RECEIPT_EVENT && String(event?.metadata?.receiptNumber || '') === String(receiptNumber || '')
  );
}

function appendReceiptEvent(pkg, receipt) {
  if (hasReceiptEvent(pkg, receipt.receiptNumber)) return false;
  appendEvent(pkg, {
    type: RECEIPT_EVENT,
    title: 'Comprovante digital de retirada emitido',
    description: `Comprovante ${receipt.receiptNumber} emitido e vinculado à retirada.`,
    occurredAt: receipt.issuedAt,
    recordedAt: receipt.issuedAt,
    actor: 'PortalSync',
    actorRole: 'sistema',
    source: 'comprovante-digital',
    metadata: {
      receiptNumber: receipt.receiptNumber,
      receiptHash: receipt.receiptHash,
      algorithm: HASH_ALGORITHM
    }
  });
  return true;
}

class WithdrawalReceiptService {
  constructor(options = {}) {
    if (!options.associations) throw new Error('AssociationManager é obrigatório.');
    this.associations = options.associations;
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
  }

  persistPackageReceipt(associationId, pkg, receipt) {
    const database = this.associations.database(associationId);
    pkg.comprovanteRetirada = { ...receipt, integrity: verifyReceipt(receipt).ok ? 'ok' : 'error' };
    appendReceiptEvent(pkg, receipt);
    database.persistCustodyEvents([pkg]);

    const clean = JSON.parse(JSON.stringify(pkg));
    database.db.prepare('UPDATE packages SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify(clean), String(pkg.id));
    database.setMeta('state_version', String(Date.now()));
    database.setMeta('updated_at', new Date().toISOString());

    const currentState = this.associations.readState(associationId);
    this.associations.writeMirror(associationId, currentState);
  }

  ensureAssociation(associationId) {
    const association = this.associations.require(associationId);
    const database = this.associations.database(association.id);
    ensureReceiptTables(database);
    const state = this.associations.readState(association.id);
    const summary = { associationId: association.id, withdrawn: 0, created: 0, recovered: 0, waiting: 0, invalid: 0 };

    for (const pkg of state.encomendas || []) {
      if (pkg?.status !== 'retirado') continue;
      summary.withdrawn++;
      let receipt = receiptForPackage(database, pkg.id);
      if (receipt) {
        if (receipt.integrity !== 'ok') {
          summary.invalid++;
          continue;
        }
        const needsAttach = !pkg.comprovanteRetirada || pkg.comprovanteRetirada.receiptHash !== receipt.receiptHash || !hasReceiptEvent(pkg, receipt.receiptNumber);
        if (needsAttach) {
          this.persistPackageReceipt(association.id, pkg, receipt);
          summary.recovered++;
        }
        continue;
      }

      if (!receiptReady(pkg)) {
        summary.waiting++;
        continue;
      }

      const issuedAt = this.now().toISOString();
      const number = allocateReceiptNumber(database, Number(issuedAt.slice(0, 4)));
      receipt = buildReceipt({ association, pkg, state, receiptNumber: number, issuedAt });
      receipt = insertReceipt(database, receipt);
      this.persistPackageReceipt(association.id, pkg, receipt);
      summary.created++;
    }
    summary.totalReceipts = receiptCount(database);
    return summary;
  }

  runAll() {
    const summaries = [];
    for (const association of this.associations.list().filter(item => item.active !== false)) {
      summaries.push(this.ensureAssociation(association.id));
    }
    return summaries;
  }
}

module.exports = {
  RECEIPT_VERSION,
  HASH_ALGORITHM,
  RECEIPT_EVENT,
  RECEIPT_TABLE,
  SEQUENCE_TABLE,
  stableStringify,
  maskDocument,
  validationInfo,
  receiptReady,
  receiptCanonical,
  hashReceipt,
  verifyReceipt,
  buildReceipt,
  ensureReceiptTables,
  receiptForPackage,
  receiptCount,
  allocateReceiptNumber,
  insertReceipt,
  appendReceiptEvent,
  WithdrawalReceiptService
};
