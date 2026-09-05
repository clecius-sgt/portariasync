'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 1;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return `pbkdf2$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [algorithm, salt, hash] = String(stored || '').split('$');
  if (algorithm !== 'pbkdf2' || !salt || !/^[a-f0-9]{64}$/i.test(hash || '')) return false;
  const calculated = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256');
  const expected = Buffer.from(hash, 'hex');
  return expected.length === calculated.length && crypto.timingSafeEqual(expected, calculated);
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function integer(value, fallback, minimum = 1) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? Math.floor(number) : fallback;
}

class AccessStore {
  constructor(options = {}) {
    const requested = options.file || path.join(process.cwd(), 'data', 'access.sqlite');
    this.file = requested === ':memory:' ? ':memory:' : path.resolve(requested);
    this.usersFile = options.usersFile ? path.resolve(options.usersFile) : null;
    this.defaultAssociationId = String(options.defaultAssociationId || 'principal');
    this.normalizeAssociationId = typeof options.normalizeAssociationId === 'function'
      ? options.normalizeAssociationId
      : value => String(value || this.defaultAssociationId);
    this.adminPassword = String(options.adminPassword || 'admin123');
    this.sessionMaxAgeMs = integer(options.sessionMaxAgeMs, 8 * 60 * 60 * 1000);
    this.maxLoginAttempts = integer(options.maxLoginAttempts, 5);
    this.lockDurationMs = integer(options.lockDurationMs, 15 * 60 * 1000);
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();

    if (this.file !== ':memory:') fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.file);
    if (this.file !== ':memory:') fs.chmodSync(this.file, 0o600);
    this.closed = false;
    this.configure();
    this.createSchema();
    this.migrateLegacyUsers();
    this.cleanupExpiredSessions();
  }

  configure() {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    if (this.file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = FULL;');
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS access_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS access_users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'porteiro', 'supervisor')),
        association_id TEXT NOT NULL,
        platform_admin INTEGER NOT NULL DEFAULT 0 CHECK(platform_admin IN (0, 1)),
        password_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER,
        last_login_at INTEGER,
        password_changed_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS access_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES access_users(id) ON DELETE CASCADE,
        association_id TEXT NOT NULL,
        platform_admin INTEGER NOT NULL DEFAULT 0 CHECK(platform_admin IN (0, 1)),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER,
        ip TEXT,
        user_agent TEXT
      );

      CREATE TABLE IF NOT EXISTS access_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        actor_user_id TEXT,
        target_user_id TEXT,
        association_id TEXT,
        ip TEXT,
        detail TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_access_users_association ON access_users(association_id, active);
      CREATE INDEX IF NOT EXISTS idx_access_sessions_user ON access_sessions(user_id, revoked_at, expires_at);
      CREATE INDEX IF NOT EXISTS idx_access_sessions_expiry ON access_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_access_events_occurred ON access_events(occurred_at DESC);
    `);
    this.db.prepare(`
      INSERT INTO access_meta(key, value) VALUES('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(SCHEMA_VERSION));
  }

  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = operation();
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch (_) {}
      throw error;
    }
  }

  migrateLegacyUsers() {
    const count = Number(this.db.prepare('SELECT COUNT(*) AS total FROM access_users').get().total || 0);
    if (count > 0) return { migrated: false, total: count };

    let users = [];
    if (this.usersFile && fs.existsSync(this.usersFile)) {
      const parsed = JSON.parse(fs.readFileSync(this.usersFile, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('users.json deve conter uma lista de usuários.');
      users = parsed;
    }
    if (!users.length) {
      users = [{
        id: 'u1',
        nome: 'Administrador',
        perfil: 'admin',
        associacaoId: this.defaultAssociationId,
        plataforma: true,
        password: hashPassword(this.adminPassword)
      }];
    }

    const now = this.now();
    const insert = this.db.prepare(`
      INSERT INTO access_users(
        id, name, role, association_id, platform_admin, password_hash, active,
        failed_attempts, locked_until, last_login_at, password_changed_at, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, 1, 0, NULL, NULL, ?, ?, ?)
    `);
    return this.transaction(() => {
      const currentCount = Number(this.db.prepare('SELECT COUNT(*) AS total FROM access_users').get().total || 0);
      if (currentCount > 0) return { migrated: false, total: currentCount };
      for (const legacy of users) {
        const id = String(legacy?.id || '').trim();
        const name = String(legacy?.nome || legacy?.name || '').trim();
        const role = String(legacy?.perfil || legacy?.role || '').trim();
        const password = String(legacy?.password || '');
        if (!id || !name || !['admin', 'porteiro', 'supervisor'].includes(role) || !password) {
          throw new Error('users.json contém um usuário inválido; migração cancelada.');
        }
        insert.run(
          id,
          name,
          role,
          this.normalizeAssociationId(legacy.associacaoId || legacy.associationId || this.defaultAssociationId),
          legacy.plataforma === true || id === 'u1' ? 1 : 0,
          password,
          now,
          now,
          now
        );
      }
      this.event('legacy_users_migrated', null, null, this.defaultAssociationId, '', String(users.length));
      return { migrated: true, total: users.length };
    });
  }

  event(type, actorUserId = null, targetUserId = null, associationId = null, ip = '', detail = '') {
    this.db.prepare(`
      INSERT INTO access_events(occurred_at, event_type, actor_user_id, target_user_id, association_id, ip, detail)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run(this.now(), String(type), actorUserId, targetUserId, associationId, String(ip || '').slice(0, 128), String(detail || '').slice(0, 500));
  }

  mapUser(row, details = false) {
    if (!row) return null;
    const user = {
      id: row.id,
      nome: row.name,
      perfil: row.role,
      associacaoId: row.association_id,
      plataforma: row.platform_admin === 1,
      ativo: row.active === 1
    };
    if (details) {
      user.tentativasFalhas = Number(row.failed_attempts || 0);
      user.bloqueadoAte = row.locked_until ? new Date(Number(row.locked_until)).toISOString() : null;
      user.ultimoLoginEm = row.last_login_at ? new Date(Number(row.last_login_at)).toISOString() : null;
      user.criadoEm = new Date(Number(row.created_at)).toISOString();
      user.atualizadoEm = new Date(Number(row.updated_at)).toISOString();
    }
    return user;
  }

  getUser(id, details = false) {
    const row = this.db.prepare('SELECT * FROM access_users WHERE id = ?').get(String(id || ''));
    return this.mapUser(row, details);
  }

  listUsers(options = {}) {
    const clauses = [];
    const params = [];
    if (!options.includeInactive) clauses.push('active = 1');
    if (options.associationId) {
      clauses.push('association_id = ?');
      params.push(String(options.associationId));
    }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    return this.db.prepare(`SELECT * FROM access_users${where} ORDER BY name COLLATE NOCASE, id`).all(...params)
      .map(row => this.mapUser(row, options.details === true));
  }

  createUser(input, actor = {}) {
    const name = String(input?.nome || input?.name || '').trim();
    const role = String(input?.perfil || input?.role || '').trim();
    const password = String(input?.senha || input?.password || '');
    const associationId = String(input?.associacaoId || input?.associationId || this.defaultAssociationId);
    if (!name || !['admin', 'porteiro', 'supervisor'].includes(role) || password.length < 8) {
      const error = new Error('Informe nome, perfil válido e senha com pelo menos 8 caracteres.');
      error.statusCode = 400;
      throw error;
    }
    const now = this.now();
    const id = String(input?.id || `u${now}${crypto.randomBytes(3).toString('hex')}`);
    this.db.prepare(`
      INSERT INTO access_users(
        id, name, role, association_id, platform_admin, password_hash, active,
        failed_attempts, locked_until, password_changed_at, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, 1, 0, NULL, ?, ?, ?)
    `).run(id, name, role, associationId, input?.plataforma === true ? 1 : 0, hashPassword(password), now, now, now);
    this.event('user_created', actor.id, id, associationId, actor.ip, role);
    return this.getUser(id, true);
  }

  authenticate(id, password, context = {}) {
    const userId = String(id || '');
    const now = this.now();
    const row = this.db.prepare('SELECT * FROM access_users WHERE id = ?').get(userId);
    const genericError = () => {
      const error = new Error('Usuário ou senha incorretos');
      error.statusCode = 401;
      return error;
    };
    if (!row || row.active !== 1) {
      this.event('login_failed', null, row?.id || null, row?.association_id || null, context.ip, row ? 'inactive' : 'unknown_user');
      throw genericError();
    }
    if (row.locked_until && Number(row.locked_until) > now) {
      this.event('login_blocked', null, row.id, row.association_id, context.ip, 'temporary_lock');
      const error = new Error('Acesso temporariamente bloqueado. Tente novamente mais tarde.');
      error.statusCode = 423;
      error.retryAfterMs = Number(row.locked_until) - now;
      throw error;
    }
    if (!verifyPassword(password, row.password_hash)) {
      const failures = Number(row.failed_attempts || 0) + 1;
      const lockedUntil = failures >= this.maxLoginAttempts ? now + this.lockDurationMs : null;
      this.db.prepare('UPDATE access_users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?')
        .run(lockedUntil ? 0 : failures, lockedUntil, now, row.id);
      this.event(lockedUntil ? 'user_temporarily_locked' : 'login_failed', null, row.id, row.association_id, context.ip, String(failures));
      if (lockedUntil) {
        const error = new Error('Acesso temporariamente bloqueado. Tente novamente mais tarde.');
        error.statusCode = 423;
        error.retryAfterMs = this.lockDurationMs;
        throw error;
      }
      throw genericError();
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = now + this.sessionMaxAgeMs;
    this.transaction(() => {
      this.db.prepare('UPDATE access_users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, row.id);
      this.db.prepare(`
        INSERT INTO access_sessions(
          token_hash, user_id, association_id, platform_admin, created_at, expires_at,
          last_seen_at, revoked_at, ip, user_agent
        ) VALUES(?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(
        tokenHash(rawToken), row.id, row.association_id, row.platform_admin,
        now, expiresAt, now, String(context.ip || '').slice(0, 128), String(context.userAgent || '').slice(0, 300)
      );
      this.event('login_succeeded', row.id, row.id, row.association_id, context.ip, '');
    });
    return { token: rawToken, session: this.requireSession(rawToken, false) };
  }

  requireSession(rawToken, touch = true) {
    if (!rawToken) return null;
    const now = this.now();
    const row = this.db.prepare(`
      SELECT s.*, u.name, u.role, u.active AS user_active
      FROM access_sessions s
      JOIN access_users u ON u.id = s.user_id
      WHERE s.token_hash = ?
    `).get(tokenHash(rawToken));
    if (!row || row.revoked_at || row.expires_at <= now || row.user_active !== 1) {
      if (row && !row.revoked_at) {
        this.db.prepare('UPDATE access_sessions SET revoked_at = ? WHERE token_hash = ?').run(now, row.token_hash);
      }
      return null;
    }
    if (touch && now - Number(row.last_seen_at) >= 60 * 1000) {
      this.db.prepare('UPDATE access_sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, row.token_hash);
    }
    return {
      id: row.user_id,
      nome: row.name,
      perfil: row.role,
      associacaoId: row.association_id,
      plataforma: row.platform_admin === 1,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at)
    };
  }

  switchAssociation(rawToken, associationId) {
    const session = this.requireSession(rawToken);
    if (!session) return null;
    const target = String(associationId || this.defaultAssociationId);
    this.db.prepare('UPDATE access_sessions SET association_id = ?, last_seen_at = ? WHERE token_hash = ?')
      .run(target, this.now(), tokenHash(rawToken));
    this.event('session_association_switched', session.id, session.id, target, '', '');
    return { ...session, associacaoId: target };
  }

  logout(rawToken, context = {}) {
    if (!rawToken) return false;
    const session = this.requireSession(rawToken, false);
    const result = this.db.prepare('UPDATE access_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(this.now(), tokenHash(rawToken));
    if (session) this.event('logout', session.id, session.id, session.associacaoId, context.ip, '');
    return Number(result.changes || 0) > 0;
  }

  setUserActive(id, active, actor = {}) {
    const target = this.getUser(id, true);
    if (!target) {
      const error = new Error('Usuário não encontrado.');
      error.statusCode = 404;
      throw error;
    }
    if (target.id === 'u1' && active !== true) {
      const error = new Error('Usuário padrão não pode ser desativado.');
      error.statusCode = 400;
      throw error;
    }
    const now = this.now();
    this.transaction(() => {
      this.db.prepare('UPDATE access_users SET active = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?')
        .run(active ? 1 : 0, now, target.id);
      if (!active) this.db.prepare('UPDATE access_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, target.id);
      this.event(active ? 'user_activated' : 'user_deactivated', actor.id, target.id, target.associacaoId, actor.ip, '');
    });
    return this.getUser(target.id, true);
  }

  resetPassword(id, password, actor = {}) {
    if (String(password || '').length < 8) {
      const error = new Error('A nova senha deve ter pelo menos 8 caracteres.');
      error.statusCode = 400;
      throw error;
    }
    const target = this.getUser(id, true);
    if (!target) {
      const error = new Error('Usuário não encontrado.');
      error.statusCode = 404;
      throw error;
    }
    const now = this.now();
    this.transaction(() => {
      this.db.prepare(`
        UPDATE access_users
        SET password_hash = ?, password_changed_at = ?, failed_attempts = 0, locked_until = NULL, updated_at = ?
        WHERE id = ?
      `).run(hashPassword(password), now, now, target.id);
      this.db.prepare('UPDATE access_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, target.id);
      this.event('password_reset', actor.id, target.id, target.associacaoId, actor.ip, 'sessions_revoked');
    });
    return this.getUser(target.id, true);
  }

  revokeUserSessions(id, actor = {}) {
    const target = this.getUser(id, true);
    if (!target) {
      const error = new Error('Usuário não encontrado.');
      error.statusCode = 404;
      throw error;
    }
    const result = this.db.prepare('UPDATE access_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(this.now(), target.id);
    this.event('sessions_revoked', actor.id, target.id, target.associacaoId, actor.ip, String(result.changes || 0));
    return Number(result.changes || 0);
  }

  overview(options = {}) {
    this.cleanupExpiredSessions();
    const associationId = options.associationId ? String(options.associationId) : null;
    const users = this.listUsers({ includeInactive: true, associationId, details: true });
    const sessionRows = associationId
      ? this.db.prepare(`
          SELECT s.user_id, u.name, u.role, s.association_id, s.created_at, s.expires_at, s.last_seen_at, s.ip
          FROM access_sessions s JOIN access_users u ON u.id = s.user_id
          WHERE s.revoked_at IS NULL AND s.expires_at > ? AND u.active = 1 AND s.association_id = ?
          ORDER BY s.last_seen_at DESC
        `).all(this.now(), associationId)
      : this.db.prepare(`
          SELECT s.user_id, u.name, u.role, s.association_id, s.created_at, s.expires_at, s.last_seen_at, s.ip
          FROM access_sessions s JOIN access_users u ON u.id = s.user_id
          WHERE s.revoked_at IS NULL AND s.expires_at > ? AND u.active = 1
          ORDER BY s.last_seen_at DESC
        `).all(this.now());
    return {
      users,
      sessions: sessionRows.map(row => ({
        usuarioId: row.user_id,
        nome: row.name,
        perfil: row.role,
        associacaoId: row.association_id,
        criadaEm: new Date(Number(row.created_at)).toISOString(),
        expiraEm: new Date(Number(row.expires_at)).toISOString(),
        vistaEm: new Date(Number(row.last_seen_at)).toISOString(),
        ip: row.ip || ''
      })),
      summary: {
        ativos: users.filter(user => user.ativo).length,
        inativos: users.filter(user => !user.ativo).length,
        bloqueados: users.filter(user => user.bloqueadoAte && Date.parse(user.bloqueadoAte) > this.now()).length,
        sessoesAtivas: sessionRows.length
      }
    };
  }

  cleanupExpiredSessions() {
    return Number(this.db.prepare('DELETE FROM access_sessions WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)')
      .run(this.now(), this.now() - 30 * 24 * 60 * 60 * 1000).changes || 0);
  }

  backupUsers() {
    return this.db.prepare(`
      SELECT id, name, role, association_id, platform_admin, password_hash, active,
             failed_attempts, locked_until, last_login_at, password_changed_at, created_at, updated_at
      FROM access_users ORDER BY id
    `).all();
  }

  status() {
    const users = this.db.prepare('SELECT COUNT(*) AS total, SUM(active) AS active FROM access_users').get();
    const sessions = this.db.prepare('SELECT COUNT(*) AS total FROM access_sessions WHERE revoked_at IS NULL AND expires_at > ?').get(this.now());
    return {
      engine: 'sqlite',
      schemaVersion: SCHEMA_VERSION,
      users: Number(users.total || 0),
      activeUsers: Number(users.active || 0),
      activeSessions: Number(sessions.total || 0),
      persistentSessions: true,
      tokenStorage: 'sha256'
    };
  }

  close() {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}

module.exports = { AccessStore, hashPassword, verifyPassword, tokenHash, SCHEMA_VERSION };
