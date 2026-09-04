'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { reconcileState } = require('./custody-chain');

const SCHEMA_VERSION = 1;

function json(value, fallback = null) {
  try { return JSON.stringify(value ?? fallback); }
  catch (_) { return JSON.stringify(fallback); }
}

function parse(value, fallback) {
  try { return value == null || value === '' ? fallback : JSON.parse(value); }
  catch (_) { return fallback; }
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function safeKey(value, fallback) {
  const text = String(value || '').trim();
  return text || fallback;
}

class StructuredDatabase {
  constructor(options = {}) {
    const requested = options.file || path.join(process.cwd(), 'data', 'portariasync.sqlite');
    this.file = requested === ':memory:' ? ':memory:' : path.resolve(requested);
    if (this.file !== ':memory:') fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.file);
    this.closed = false;
    this.configure();
    this.createSchema();
  }

  configure() {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    if (this.file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS residents (
        id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        house TEXT NOT NULL,
        whatsapp TEXT,
        kind TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS packages (
        id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        code TEXT,
        status TEXT,
        resident_id TEXT,
        resident_name TEXT,
        resident_house TEXT,
        resident_whatsapp TEXT,
        carrier TEXT,
        entry_at TEXT,
        withdrawal_at TEXT,
        pin_sent INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS related_withdrawers (
        row_key TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        resident_id TEXT,
        name TEXT,
        document TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        position INTEGER PRIMARY KEY,
        action TEXT,
        occurred_at TEXT,
        user_name TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS withdrawal_details (
        package_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sender_memory (
        sender_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public_config (
        config_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_residents_name ON residents(name);
      CREATE INDEX IF NOT EXISTS idx_residents_house ON residents(house);
      CREATE INDEX IF NOT EXISTS idx_packages_code ON packages(code);
      CREATE INDEX IF NOT EXISTS idx_packages_status ON packages(status);
      CREATE INDEX IF NOT EXISTS idx_packages_resident ON packages(resident_id);
      CREATE INDEX IF NOT EXISTS idx_packages_entry ON packages(entry_at);
      CREATE INDEX IF NOT EXISTS idx_withdrawers_resident ON related_withdrawers(resident_id);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
    `);
    this.setMeta('schema_version', String(SCHEMA_VERSION));
  }

  setMeta(key, value) {
    this.db.prepare(`
      INSERT INTO app_meta(key, value) VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(String(key), value == null ? null : String(value));
  }

  getMeta(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM app_meta WHERE key = ?').get(String(key));
    return row ? row.value : fallback;
  }

  hasState() {
    return this.getMeta('state_exists', '0') === '1';
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch (_) {}
      throw error;
    }
  }

  writeState(state) {
    if (!state || typeof state !== 'object') throw new Error('Estado do aplicativo inválido para o banco estruturado.');
    const previousState = this.hasState() ? this.readState() : { exists: false, encomendas: [] };
    const effectiveState = reconcileState(previousState, state);
    const residents = Array.isArray(effectiveState.moradores) ? effectiveState.moradores : [];
    const packages = Array.isArray(effectiveState.encomendas) ? effectiveState.encomendas : [];
    const withdrawers = Array.isArray(effectiveState.retirantesRelacionados) ? effectiveState.retirantesRelacionados : [];
    const audit = Array.isArray(effectiveState.auditoria) ? effectiveState.auditoria : [];
    const details = effectiveState.detalhesRetirada && typeof effectiveState.detalhesRetirada === 'object' ? effectiveState.detalhesRetirada : {};
    const senders = effectiveState.memoriaRemetentes && typeof effectiveState.memoriaRemetentes === 'object' ? effectiveState.memoriaRemetentes : {};
    const config = effectiveState.configPublica && typeof effectiveState.configPublica === 'object' ? effectiveState.configPublica : {};

    this.transaction(() => {
      this.db.exec(`
        DELETE FROM residents;
        DELETE FROM packages;
        DELETE FROM related_withdrawers;
        DELETE FROM audit_log;
        DELETE FROM withdrawal_details;
        DELETE FROM sender_memory;
        DELETE FROM public_config;
      `);

      const insertResident = this.db.prepare(`
        INSERT INTO residents(id, position, name, house, whatsapp, kind, payload_json)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `);
      residents.forEach((item, position) => {
        if (!item || !item.id) return;
        insertResident.run(
          String(item.id), position, String(item.nome || ''), String(item.casa || ''), digits(item.whats),
          String(item.tipo || ''), json(item, {})
        );
      });

      const insertPackage = this.db.prepare(`
        INSERT INTO packages(
          id, position, code, status, resident_id, resident_name, resident_house,
          resident_whatsapp, carrier, entry_at, withdrawal_at, pin_sent, payload_json
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      packages.forEach((item, position) => {
        if (!item || !item.id) return;
        insertPackage.run(
          String(item.id), position, String(item.codigo || ''), String(item.status || ''),
          String(item.moradorId || ''), String(item.moradorNome || ''), String(item.moradorCasa || ''),
          digits(item.moradorWhats), String(item.transportadora || ''), String(item.dataEntrada || ''),
          String(item.dataRetirada || ''), item.pinRetiradaEnviado === true ? 1 : 0, json(item, {})
        );
      });

      const insertWithdrawer = this.db.prepare(`
        INSERT INTO related_withdrawers(row_key, position, resident_id, name, document, payload_json)
        VALUES(?, ?, ?, ?, ?, ?)
      `);
      const usedWithdrawerKeys = new Set();
      withdrawers.forEach((item, position) => {
        if (!item) return;
        const base = safeKey(item.id, [item.moradorId || '', digits(item.rg), item.nome || ''].join('|')) || 'withdrawer-' + position;
        let key = base;
        let suffix = 2;
        while (usedWithdrawerKeys.has(key)) key = base + '#' + suffix++;
        usedWithdrawerKeys.add(key);
        insertWithdrawer.run(
          key, position, String(item.moradorId || ''), String(item.nome || ''), digits(item.rg), json(item, {})
        );
      });

      const insertAudit = this.db.prepare(`
        INSERT INTO audit_log(position, action, occurred_at, user_name, payload_json)
        VALUES(?, ?, ?, ?, ?)
      `);
      audit.forEach((item, position) => {
        if (!item) return;
        insertAudit.run(
          position,
          String(item.acao || item.action || ''),
          String(item.data || item.createdAt || item.ocorridoEm || ''),
          String(item.usuario || item.usuarioNome || ''),
          json(item, {})
        );
      });

      const insertDetail = this.db.prepare('INSERT INTO withdrawal_details(package_id, payload_json) VALUES(?, ?)');
      Object.entries(details).forEach(([key, value]) => insertDetail.run(String(key), json(value, {})));

      const insertSender = this.db.prepare('INSERT INTO sender_memory(sender_key, payload_json) VALUES(?, ?)');
      Object.entries(senders).forEach(([key, value]) => insertSender.run(String(key), json(value, {})));

      const insertConfig = this.db.prepare('INSERT INTO public_config(config_key, payload_json) VALUES(?, ?)');
      Object.entries(config).forEach(([key, value]) => insertConfig.run(String(key), json(value, null)));

      this.setMeta('state_exists', '1');
      this.setMeta('state_version', String(Number(effectiveState.version || Date.now())));
      this.setMeta('updated_at', String(effectiveState.updatedAt || new Date().toISOString()));
      this.setMeta('reset_packages_at', effectiveState.resetEncomendasAt || '');
      this.setMeta('schema_version', String(SCHEMA_VERSION));
    });
    return this.status();
  }

  readState() {
    if (!this.hasState()) {
      return { exists: false, version: 0, updatedAt: null, storage: 'sqlite', databaseSchema: SCHEMA_VERSION };
    }

    const moradores = this.db.prepare('SELECT payload_json FROM residents ORDER BY position ASC').all()
      .map(row => parse(row.payload_json, {}));
    const encomendas = this.db.prepare('SELECT payload_json FROM packages ORDER BY position ASC').all()
      .map(row => parse(row.payload_json, {}));
    const retirantesRelacionados = this.db.prepare('SELECT payload_json FROM related_withdrawers ORDER BY position ASC').all()
      .map(row => parse(row.payload_json, {}));
    const auditoria = this.db.prepare('SELECT payload_json FROM audit_log ORDER BY position ASC').all()
      .map(row => parse(row.payload_json, {}));

    const detalhesRetirada = {};
    for (const row of this.db.prepare('SELECT package_id, payload_json FROM withdrawal_details').all()) {
      detalhesRetirada[row.package_id] = parse(row.payload_json, {});
    }
    const memoriaRemetentes = {};
    for (const row of this.db.prepare('SELECT sender_key, payload_json FROM sender_memory').all()) {
      memoriaRemetentes[row.sender_key] = parse(row.payload_json, {});
    }
    const configPublica = {};
    for (const row of this.db.prepare('SELECT config_key, payload_json FROM public_config').all()) {
      configPublica[row.config_key] = parse(row.payload_json, null);
    }

    return {
      exists: true,
      version: Number(this.getMeta('state_version', '0')) || 0,
      updatedAt: this.getMeta('updated_at', null),
      moradores,
      encomendas,
      retirantesRelacionados,
      auditoria,
      detalhesRetirada,
      memoriaRemetentes,
      configPublica,
      resetEncomendasAt: this.getMeta('reset_packages_at', '') || null,
      storage: 'sqlite',
      databaseSchema: SCHEMA_VERSION
    };
  }

  initializeFromJsonMirror(jsonPath) {
    if (this.hasState()) return { migrated: false, reason: 'database-already-initialized', status: this.status() };
    if (!jsonPath || !fs.existsSync(jsonPath)) return { migrated: false, reason: 'json-mirror-not-found', status: this.status() };
    const state = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const useful = Array.isArray(state.moradores) || Array.isArray(state.encomendas) || Array.isArray(state.auditoria);
    if (!useful) return { migrated: false, reason: 'json-mirror-empty', status: this.status() };
    this.writeState(state);
    return { migrated: true, reason: 'json-mirror-imported', status: this.status() };
  }

  integrity() {
    const row = this.db.prepare('PRAGMA integrity_check').get();
    const value = row ? Object.values(row)[0] : null;
    return String(value || '').toLowerCase() === 'ok' ? 'ok' : String(value || 'unknown');
  }

  counts() {
    const count = table => Number(this.db.prepare('SELECT COUNT(*) AS total FROM ' + table).get()?.total || 0);
    return {
      residents: count('residents'),
      packages: count('packages'),
      relatedWithdrawers: count('related_withdrawers'),
      audit: count('audit_log'),
      withdrawalDetails: count('withdrawal_details'),
      senderMemory: count('sender_memory'),
      publicConfig: count('public_config')
    };
  }

  status() {
    return {
      ready: !this.closed,
      engine: 'sqlite',
      schemaVersion: SCHEMA_VERSION,
      file: this.file === ':memory:' ? ':memory:' : path.basename(this.file),
      exists: this.hasState(),
      integrity: this.integrity(),
      counts: this.counts()
    };
  }

  close() {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}

module.exports = { StructuredDatabase, SCHEMA_VERSION, digits, parse };
