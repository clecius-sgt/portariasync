'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'morador.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'morador-portal.js'), 'utf8');

test('portal do morador possui login por WhatsApp e áreas de encomendas', () => {
  assert.match(html, /Portal do Morador/);
  assert.match(html, /Receber código/);
  assert.match(html, /Encomendas aguardando retirada/);
  assert.match(html, /Histórico de retiradas/);
  assert.match(html, /morador-portal\.js/);
});

test('frontend usa endpoints isolados do portal do morador', () => {
  assert.match(js, /\/api\/morador\/auth\/request/);
  assert.match(js, /\/api\/morador\/auth\/verify/);
  assert.match(js, /\/api\/morador\/me/);
  assert.match(js, /\/api\/morador\/encomendas/);
  assert.match(js, /reenviar-pin/);
  assert.match(js, /Authorization = 'Resident '/);
});

test('portal permite criar e cancelar autorização digital para terceiro', () => {
  assert.match(html, /autorizar digitalmente outra pessoa/i);
  assert.match(js, /Autorizar outra pessoa a retirar/);
  assert.match(js, /\/autorizacao/);
  assert.match(js, /validadeHoras/);
  assert.match(js, /Código de autorização/);
  assert.match(js, /Cancelar autorização/);
});
