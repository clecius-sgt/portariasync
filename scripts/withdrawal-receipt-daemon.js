#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { AssociationManager } = require('../association-manager');
const { WithdrawalReceiptService } = require('../withdrawal-receipt');

const ROOT = path.resolve(__dirname, '..');
loadEnv(path.join(ROOT, '.env'));

const DATA_DIR = path.join(ROOT, 'data');
const intervalSeconds = Math.max(5, Number(process.env.WITHDRAWAL_RECEIPTS_INTERVAL_SECONDS || 15));
const associations = new AssociationManager({
  dataDir: DATA_DIR,
  defaultName: process.env.DEFAULT_ASSOCIATION_NAME || 'Associação de Moradores'
});
const service = new WithdrawalReceiptService({ associations });
let running = false;

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

async function run() {
  if (running) return;
  running = true;
  try {
    const summaries = service.runAll();
    const changed = summaries.reduce((sum, item) => sum + item.created + item.recovered, 0);
    const invalid = summaries.reduce((sum, item) => sum + item.invalid, 0);
    if (changed || invalid) console.log('Comprovantes:', JSON.stringify(summaries));
  } catch (error) {
    console.error('Falha no comprovante digital:', String(error?.message || error));
  } finally {
    running = false;
  }
}

console.log('Comprovantes digitais de retirada do PortariaSync ativos.');
console.log('Verificação a cada ' + intervalSeconds + ' segundo(s).');
console.log('Multi-Associação:', associations.status(false).total, 'associação(ões).');

run();
const timer = setInterval(run, intervalSeconds * 1000);

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    clearInterval(timer);
    associations.closeAll();
    process.exit(0);
  });
}
