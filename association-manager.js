'use strict';

const fs = require('fs');
const path = require('path');
const { StructuredDatabase } = require('./structured-database');

const DEFAULT_ASSOCIATION_ID = 'principal';

function normalizeAssociationId(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function safeAssociationId(value, fallback = DEFAULT_ASSOCIATION_ID) {
  const id = normalizeAssociationId(value);
  if (!id) return fallback;
  if (id.length < 3) throw new Error('Identificador da associação deve possuir ao menos 3 caracteres.');
  return id;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function emptyState() {
  const now = new Date().toISOString();
  return {
    version: Date.now(),
    updatedAt: now,
    moradores: [],
    encomendas: [],
    retirantesRelacionados: [],
    auditoria: [],
    detalhesRetirada: {},
    memoriaRemetentes: {},
    configPublica: {},
    resetEncomendasAt: null
  };
}

class AssociationManager {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir || path.join(process.cwd(), 'data'));
    this.registryFile = path.resolve(options.registryFile || path.join(this.dataDir, 'associations.json'));
    this.defaultDatabaseFile = path.resolve(options.defaultDatabaseFile || path.join(this.dataDir, 'portariasync.sqlite'));
    this.defaultMirrorFile = path.resolve(options.defaultMirrorFile || path.join(this.dataDir, 'app-state.json'));
    this.associationsDir = path.resolve(options.associationsDir || path.join(this.dataDir, 'associations'));
    this.defaultName = String(options.defaultName || 'Associação de Moradores').trim() || 'Associação de Moradores';
    this.databases = new Map();
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.associationsDir, { recursive: true, mode: 0o700 });
    this.ensureRegistry();
  }

  ensureRegistry() {
    let registry = null;
    try {
      if (fs.existsSync(this.registryFile)) registry = JSON.parse(fs.readFileSync(this.registryFile, 'utf8'));
    } catch (_) {}
    if (!registry || !Array.isArray(registry.associations)) registry = { version: 1, associations: [] };
    if (!registry.associations.some(item => item && item.id === DEFAULT_ASSOCIATION_ID)) {
      registry.associations.unshift({
        id: DEFAULT_ASSOCIATION_ID,
        name: this.defaultName,
        active: true,
        legacyPrimary: true,
        createdAt: new Date().toISOString()
      });
      atomicJson(this.registryFile, registry);
    }
    this.registry = registry;
    return registry;
  }

  saveRegistry() {
    this.registry.version = Number(this.registry.version || 1);
    this.registry.updatedAt = new Date().toISOString();
    atomicJson(this.registryFile, this.registry);
  }

  list() {
    return this.registry.associations
      .filter(Boolean)
      .map(item => ({
        id: item.id,
        name: item.name,
        active: item.active !== false,
        createdAt: item.createdAt || null,
        legacyPrimary: item.legacyPrimary === true
      }));
  }

  get(id = DEFAULT_ASSOCIATION_ID) {
    const resolved = safeAssociationId(id);
    return this.registry.associations.find(item => item && item.id === resolved) || null;
  }

  require(id = DEFAULT_ASSOCIATION_ID) {
    const association = this.get(id);
    if (!association || association.active === false) {
      const error = new Error('Associação não encontrada ou inativa.');
      error.statusCode = 404;
      throw error;
    }
    return association;
  }

  paths(id = DEFAULT_ASSOCIATION_ID) {
    const association = this.require(id);
    if (association.id === DEFAULT_ASSOCIATION_ID) {
      return { database: this.defaultDatabaseFile, mirror: this.defaultMirrorFile };
    }
    const dir = path.join(this.associationsDir, association.id);
    return {
      database: path.join(dir, 'portariasync.sqlite'),
      mirror: path.join(dir, 'app-state.json')
    };
  }

  database(id = DEFAULT_ASSOCIATION_ID) {
    const association = this.require(id);
    if (this.databases.has(association.id)) return this.databases.get(association.id);
    const files = this.paths(association.id);
    const db = new StructuredDatabase({ file: files.database });
    db.initializeFromJsonMirror(files.mirror);
    this.databases.set(association.id, db);
    return db;
  }

  readState(id = DEFAULT_ASSOCIATION_ID) {
    const association = this.require(id);
    const state = this.database(association.id).readState();
    return {
      ...state,
      associacao: { id: association.id, nome: association.name }
    };
  }

  writeMirror(id, state, storage = 'sqlite+json-mirror') {
    const files = this.paths(id);
    let authoritative = state;
    try {
      const fromDatabase = this.database(id).readState();
      if (fromDatabase && fromDatabase.exists) {
        authoritative = {
          ...state,
          ...fromDatabase,
          version: fromDatabase.version || state?.version || Date.now(),
          updatedAt: fromDatabase.updatedAt || state?.updatedAt || new Date().toISOString()
        };
      }
    } catch (_) {}
    delete authoritative.associacao;
    atomicJson(files.mirror, { ...authoritative, storage });
  }

  writeState(id = DEFAULT_ASSOCIATION_ID, state) {
    const association = this.require(id);
    const clean = { ...state };
    delete clean.associacao;
    this.database(association.id).writeState(clean);
    this.writeMirror(association.id, clean);
    return this.readState(association.id);
  }

  create(input = {}) {
    const name = String(input.name || input.nome || '').trim();
    if (name.length < 3) throw new Error('Informe o nome da associação.');
    const id = safeAssociationId(input.id || input.slug || name);
    if (this.get(id)) {
      const error = new Error('Já existe uma associação com este identificador.');
      error.statusCode = 409;
      throw error;
    }
    const association = {
      id,
      name,
      active: true,
      legacyPrimary: false,
      createdAt: new Date().toISOString()
    };
    this.registry.associations.push(association);
    this.saveRegistry();
    const state = emptyState();
    this.database(id).writeState(state);
    this.writeMirror(id, state);
    return { ...association };
  }

  publicInfo(id = DEFAULT_ASSOCIATION_ID) {
    const item = this.require(id);
    return { id: item.id, nome: item.name };
  }

  status(includeCounts = false) {
    const associations = this.list().map(item => {
      const base = { id: item.id, nome: item.name, active: item.active };
      if (!includeCounts) return base;
      try {
        const status = this.database(item.id).status();
        return { ...base, database: { integrity: status.integrity, counts: status.counts } };
      } catch (error) {
        return { ...base, database: { integrity: 'error', error: error.message } };
      }
    });
    return {
      enabled: true,
      mode: 'database-per-association',
      defaultAssociationId: DEFAULT_ASSOCIATION_ID,
      total: associations.length,
      active: associations.filter(item => item.active).length,
      associations
    };
  }

  snapshotAll() {
    return this.list().map(item => ({
      association: { id: item.id, nome: item.name, active: item.active },
      state: this.readState(item.id),
      status: this.database(item.id).status()
    }));
  }

  closeAll() {
    for (const db of this.databases.values()) {
      try { db.close(); } catch (_) {}
    }
    this.databases.clear();
  }
}

module.exports = {
  AssociationManager,
  DEFAULT_ASSOCIATION_ID,
  normalizeAssociationId,
  safeAssociationId,
  emptyState
};
