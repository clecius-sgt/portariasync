'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('servidor integra serviço e rotas do portal do morador', () => {
  assert.match(server, /ResidentPortalService/);
  assert.match(server, /\/api\/morador\/auth\/request/);
  assert.match(server, /\/api\/morador\/auth\/verify/);
  assert.match(server, /\/api\/morador\/me/);
  assert.match(server, /\/api\/morador\/encomendas/);
  assert.match(server, /reenviar-pin/);
  assert.match(server, /residentPortal: residentPortal\.status\(\)/);
});
