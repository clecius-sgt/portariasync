'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

test('servidor usa SQLite como armazenamento primário com isolamento por associação', () => {
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(source, /AssociationManager/);
  assert.match(source, /associations\.database\(DEFAULT_ASSOCIATION_ID\)/);
  assert.match(source, /associations\.readState\(scoped\)/);
  assert.match(source, /associations\.database\(scoped\)\.writeState\(clean\)/);
  assert.match(source, /database:\s*database\.status\(\)/);
  assert.match(source, /storage:\s*'sqlite'/);
  assert.match(source, /associations\.writeMirror/);
});

test('backup automático prioriza snapshots estruturados de todas as associações', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'backup-daemon.js'), 'utf8');
  assert.match(source, /AssociationManager/);
  assert.match(source, /sqlite-multi-association-access/);
  assert.match(source, /associations:\s*associations\.snapshotAll\(\)/);
  assert.match(source, /access\.backupUsers\(\)/);
  assert.match(source, /users-legacy\.json/);
});
