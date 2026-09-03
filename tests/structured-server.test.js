'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

test('servidor usa SQLite como armazenamento primário com espelho JSON', () => {
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(source, /StructuredDatabase/);
  assert.match(source, /portariasync\.sqlite/);
  assert.match(source, /database\.initializeFromJsonMirror\(APP_STATE_FILE\)/);
  assert.match(source, /database\.writeState\(state\)/);
  assert.match(source, /database:\s*database\.status\(\)/);
  assert.match(source, /storage:\s*'sqlite'/);
  assert.match(source, /writeJsonMirror/);
});

test('backup automático prioriza snapshot do banco estruturado', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'backup-daemon.js'), 'utf8');
  assert.match(source, /StructuredDatabase/);
  assert.match(source, /sqlite-structured-primary/);
  assert.match(source, /database:\s*structured/);
  assert.match(source, /app-state\.json/);
});
