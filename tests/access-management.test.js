'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('servidor usa SQLite global para usuários e sessões persistentes', () => {
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(source, /new AccessStore\(/);
  assert.match(source, /path\.join\(DATA_DIR, 'access\.sqlite'\)/);
  assert.match(source, /access\.authenticate\(id, senha/);
  assert.match(source, /access\.requireSession\(token\)/);
  assert.match(source, /access\.switchAssociation/);
  assert.match(source, /access\.logout/);
  assert.doesNotMatch(source, /const sessions = new Map/);
});

test('rotas administrativas permitem gerir situação, senha e sessões', () => {
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(source, /\/api\/access\/overview/);
  assert.match(source, /userStatusMatch/);
  assert.match(source, /access\.setUserActive/);
  assert.match(source, /access\.resetPassword/);
  assert.match(source, /access\.revokeUserSessions/);
  assert.match(source, /requireUserScope/);
});

test('painel de acessos exige sessão administrativa e oferece controles', () => {
  const html = fs.readFileSync(path.join(root, 'acessos.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'acessos-admin.js'), 'utf8');
  assert.match(html, /Gestão de Acessos/);
  assert.match(html, /Sessões ativas/);
  assert.match(html, /Bloqueios temporários/i);
  assert.match(script, /\/api\/auth\/me/);
  assert.match(script, /perfil !== 'admin'/);
  assert.match(script, /\/api\/access\/overview/);
  assert.match(script, /method: 'PATCH'/);
  assert.match(script, /\/password/);
  assert.match(script, /\/sessions/);
});

test('atalhos administrativos apontam para o painel de acessos', () => {
  const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(admin, /href="\/acessos\.html"/);
  assert.match(index, /Abrir Gestão de Acessos e Sessões/);
  assert.match(index, /Senha mínima: 8 caracteres/);
  assert.match(index, /localStorage\.removeItem\('usuarios'\)/);
  assert.match(index, /acesso local sem validação foi desativado por segurança/);
  assert.doesNotMatch(index, /senha:\s*'admin123'/);
});
