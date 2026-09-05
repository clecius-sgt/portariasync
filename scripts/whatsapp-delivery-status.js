#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { WhatsAppDeliveryStore } = require('../whatsapp-delivery-store');

const ROOT = path.resolve(__dirname, '..');
loadEnv(path.join(ROOT, '.env'));

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

const store = new WhatsAppDeliveryStore({
  filePath: String(process.env.WHATSAPP_TRACKING_DB || '').trim() || path.join(ROOT, 'data', 'whatsapp-delivery.sqlite')
});

try {
  const summary = store.summary();
  const messages = store.list(Number(process.argv[2] || 15));

  console.log('Rastreamento WhatsApp - PortalSync');
  console.log('Total:', summary.total);
  console.log('Aceitas:', summary.accepted);
  console.log('Enviadas:', summary.sent);
  console.log('Recebidas:', summary.received);
  console.log('Lidas:', summary.read);
  console.log('Falhas:', summary.failed);
  console.log('Última atualização:', summary.lastUpdateAt || '-');

  if (!messages.length) {
    console.log('\nNenhuma mensagem rastreada ainda.');
  } else {
    console.log('\nÚltimas mensagens:');
    for (const item of messages) {
      const reference = item.referenceId ? ` | ref=${item.referenceId}` : '';
      const failure = item.error ? ` | erro=${item.error}` : '';
      console.log(`${item.updatedAt} | ${item.kind} | ${item.phone || '-'} | ${item.status}${reference}${failure}`);
    }
  }
} finally {
  store.close();
}
