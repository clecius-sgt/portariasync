'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const auth = require('../withdrawal-authorization');

const root = path.resolve(__dirname, '..');

test('autorização ativa respeita validade e status explícito', () => {
  const pkg = {
    autorizacoesRetirada: [
      { id:'a1', nome:'Maria', documento:'RG 12.345-X', status:'cancelada', criadaEm:'2026-09-03T10:00:00Z', expiraEm:'2026-09-04T10:00:00Z' },
      { id:'a2', nome:'Carlos', documento:'CNH 998877', status:'ativa', criadaEm:'2026-09-03T12:00:00Z', expiraEm:'2026-09-04T12:00:00Z' }
    ]
  };
  const now = Date.parse('2026-09-03T18:00:00Z');
  assert.equal(auth.activeAuthorization(pkg, now).id, 'a2');
  assert.equal(auth.status(auth.activeAuthorization(pkg, now), now), 'ativa');
  assert.equal(auth.activeAuthorization(pkg, Date.parse('2026-09-05T18:00:00Z')), null);
});

test('normalização impede diferença apenas de máscara em documento e nome', () => {
  assert.equal(auth.normalizeDocument('RG 12.345.678-X'), 'RG12345678X');
  assert.equal(auth.normalizeName('  José   da Silva '), 'JOSE DA SILVA');
});

test('cliente da portaria valida autorização no backend antes da retirada', () => {
  const source = fs.readFileSync(path.join(root, 'withdrawal-authorization.js'), 'utf8');
  assert.match(source, /\/api\/withdrawal-authorization\/verify/);
  assert.match(source, /código de 6 dígitos/i);
  assert.match(source, /_retiranteTipo !== 'outro'/);
  assert.match(source, /autorização digital ativa/i);
  assert.match(source, /Authorization: 'Bearer '/);
});
