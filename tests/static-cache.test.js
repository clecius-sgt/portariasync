const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('scripts e HTML do aplicativo não ficam presos em cache antigo', () => {
  assert.match(source, /const appDinamico = \(ext === '\.html' \|\| ext === '\.js'\) && !partes\.includes\('vendor'\)/);
  assert.match(source, /'Cache-Control': appDinamico \? 'no-store, max-age=0' : 'public, max-age=86400'/);
});

test('bibliotecas pesadas de vendor continuam podendo usar cache', () => {
  assert.match(source, /!partes\.includes\('vendor'\)/);
  assert.match(source, /public, max-age=86400/);
});
