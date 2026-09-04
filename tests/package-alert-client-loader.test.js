'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('Cadeia de Custódia carrega os indicadores de alertas sem alterar o HTML principal', () => {
  const custody = fs.readFileSync(path.join(root, 'custody-chain-client.js'), 'utf8');
  assert.match(custody, /package-alerts-client\.js\?v=20260904-1/);
  assert.match(custody, /loadPackageAlerts\(root\)/);
  assert.match(custody, /data-package-alerts/);
});

test('painel de alertas usa a sessão existente e salva política no estado da associação', () => {
  const page = fs.readFileSync(path.join(root, 'alertas.js'), 'utf8');
  assert.match(page, /localStorage\.getItem\('authToken'\)/);
  assert.match(page, /\/api\/auth\/me/);
  assert.match(page, /\/api\/app-state/);
  assert.match(page, /packageAlertsPolicy/);
  assert.match(page, /packageAlertsSuspended/);
});
