#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { AssociationManager } = require('../association-manager');
const { WhatsAppProvider } = require('../whatsapp-provider');
const { PackageAlertService } = require('../package-alert-service');

const ROOT = path.resolve(__dirname, '..');
loadEnv(path.join(ROOT, '.env'));

const DATA_DIR = path.join(ROOT, 'data');
const intervalMinutes = Math.max(1, Number(process.env.PACKAGE_ALERTS_INTERVAL_MINUTES || 15));
const startupDelayMs = Math.max(1000, Number(process.env.PACKAGE_ALERTS_STARTUP_DELAY_MS || 5000));
const associations = new AssociationManager({
  dataDir: DATA_DIR,
  defaultName: process.env.DEFAULT_ASSOCIATION_NAME || 'Associação de Moradores'
});
const whatsapp = new WhatsAppProvider();
const service = new PackageAlertService({
  associations,
  whatsapp,
  intervalMs: intervalMinutes * 60 * 1000,
  startupDelayMs
});

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

service.start();
console.log('Alertas inteligentes do PortariaSync ativos.');
console.log('Verificação a cada ' + intervalMinutes + ' minuto(s).');
console.log('Multi-Associação:', associations.status(false).total, 'associação(ões).');
console.log('WhatsApp:', whatsapp.status().configured ? 'configurado' : 'não configurado');

// Este timer permanece referenciado de propósito. Ele mantém o daemon residente
// no PM2 mesmo quando os timers internos do serviço são unref para facilitar testes.
const logTimer = setInterval(() => {
  const status = service.status();
  if (!status.lastRunAt) return;
  console.log('Alertas - última verificação:', status.lastRunAt, JSON.stringify(status.lastSummary || {}));
  if (status.lastError) console.warn('Alertas - última falha:', status.lastError);
}, 60 * 60 * 1000);

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    service.stop();
    clearInterval(logTimer);
    associations.closeAll();
    process.exit(0);
  });
}
