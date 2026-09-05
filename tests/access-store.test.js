'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { AccessStore, hashPassword, tokenHash } = require('../access-store');

function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portariasync-access-'));
  const usersFile = path.join(directory, 'users.json');
  const password = 'SenhaSegura123';
  fs.writeFileSync(usersFile, JSON.stringify([
    {
      id: 'u1',
      nome: 'Administrador',
      perfil: 'admin',
      associacaoId: 'principal',
      plataforma: true,
      password: hashPassword(password)
    },
    {
      id: 'u2',
      nome: 'Porteiro Teste',
      perfil: 'porteiro',
      associacaoId: 'principal',
      plataforma: false,
      password: hashPassword(password)
    }
  ]));
  const store = new AccessStore({
    file: path.join(directory, 'access.sqlite'),
    usersFile,
    defaultAssociationId: 'principal',
    sessionMaxAgeMs: options.sessionMaxAgeMs || 60_000,
    maxLoginAttempts: options.maxLoginAttempts || 3,
    lockDurationMs: options.lockDurationMs || 15_000,
    now: options.now
  });
  return {
    directory,
    usersFile,
    password,
    store,
    close() {
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('migra usuários legados uma única vez sem alterar o users.json', () => {
  const env = fixture();
  try {
    assert.equal(env.store.listUsers().length, 2);
    assert.equal(env.store.getUser('u1').plataforma, true);
    assert.equal(fs.statSync(path.join(env.directory, 'access.sqlite')).mode & 0o777, 0o600);
    const original = fs.readFileSync(env.usersFile, 'utf8');
    env.store.close();
    env.store = new AccessStore({
      file: path.join(env.directory, 'access.sqlite'),
      usersFile: env.usersFile,
      defaultAssociationId: 'principal'
    });
    assert.equal(env.store.listUsers().length, 2);
    assert.equal(fs.readFileSync(env.usersFile, 'utf8'), original);
  } finally {
    env.close();
  }
});

test('persiste a sessão entre reinícios e nunca grava o token bruto', () => {
  const env = fixture();
  try {
    const login = env.store.authenticate('u2', env.password, { ip: '127.0.0.1' });
    assert.equal(login.session.id, 'u2');
    const rawToken = login.token;
    env.store.close();
    env.store = new AccessStore({
      file: path.join(env.directory, 'access.sqlite'),
      usersFile: env.usersFile,
      defaultAssociationId: 'principal',
      sessionMaxAgeMs: 60_000
    });
    assert.equal(env.store.requireSession(rawToken).id, 'u2');

    const db = new DatabaseSync(path.join(env.directory, 'access.sqlite'), { readOnly: true });
    const row = db.prepare('SELECT token_hash FROM access_sessions').get();
    db.close();
    assert.equal(row.token_hash, tokenHash(rawToken));
    assert.notEqual(row.token_hash, rawToken);
  } finally {
    env.close();
  }
});

test('expira sessão e rejeita o token vencido', () => {
  let now = 1_000_000;
  const env = fixture({ now: () => now, sessionMaxAgeMs: 1_000 });
  try {
    const login = env.store.authenticate('u2', env.password);
    assert.ok(env.store.requireSession(login.token));
    now += 1_001;
    assert.equal(env.store.requireSession(login.token), null);
  } finally {
    env.close();
  }
});

test('bloqueia temporariamente após repetidas tentativas inválidas', () => {
  let now = 2_000_000;
  const env = fixture({ now: () => now, maxLoginAttempts: 3, lockDurationMs: 10_000 });
  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      assert.throws(() => env.store.authenticate('u2', 'incorreta'), error => error.statusCode === 401);
    }
    assert.throws(() => env.store.authenticate('u2', 'incorreta'), error => error.statusCode === 423);
    assert.throws(() => env.store.authenticate('u2', env.password), error => error.statusCode === 423);
    now += 10_001;
    assert.equal(env.store.authenticate('u2', env.password).session.id, 'u2');
  } finally {
    env.close();
  }
});

test('desativação e troca de senha revogam todas as sessões', () => {
  const env = fixture();
  try {
    const first = env.store.authenticate('u2', env.password).token;
    const second = env.store.authenticate('u2', env.password).token;
    env.store.setUserActive('u2', false, { id: 'u1' });
    assert.equal(env.store.requireSession(first), null);
    assert.equal(env.store.requireSession(second), null);
    assert.throws(() => env.store.authenticate('u2', env.password), error => error.statusCode === 401);

    env.store.setUserActive('u2', true, { id: 'u1' });
    const third = env.store.authenticate('u2', env.password).token;
    env.store.resetPassword('u2', 'OutraSenha123', { id: 'u1' });
    assert.equal(env.store.requireSession(third), null);
    assert.throws(() => env.store.authenticate('u2', env.password), error => error.statusCode === 401);
    assert.equal(env.store.authenticate('u2', 'OutraSenha123').session.id, 'u2');
  } finally {
    env.close();
  }
});

test('overview não expõe hashes de senha nem hashes de token', () => {
  const env = fixture();
  try {
    env.store.authenticate('u2', env.password, { ip: '127.0.0.1' });
    const overview = env.store.overview();
    assert.equal(overview.summary.ativos, 2);
    assert.equal(overview.summary.sessoesAtivas, 1);
    const serialized = JSON.stringify(overview);
    assert.doesNotMatch(serialized, /password_hash|token_hash|SenhaSegura123/);
  } finally {
    env.close();
  }
});
