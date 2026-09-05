#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
loadEnv(ENV_FILE);

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

function ensureSecret() {
  let secret = String(process.env.ZAPI_WEBHOOK_SECRET || '').trim();
  if (secret) return { secret, created: false };
  secret = crypto.randomBytes(24).toString('hex');
  const existing = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(ENV_FILE, `${prefix}ZAPI_WEBHOOK_SECRET=${secret}\n`, { mode: 0o600 });
  process.env.ZAPI_WEBHOOK_SECRET = secret;
  return { secret, created: true };
}

async function putWebhook(url, client, value) {
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Client-Token': client
    },
    body: JSON.stringify({ value })
  });
  let payload = null;
  try { payload = await response.json(); } catch (_) {}
  if (!response.ok) {
    throw new Error(`Z-API respondeu ${response.status}: ${payload?.error || 'falha ao configurar webhook'}`);
  }
  return payload;
}

(async () => {
  const zapiUrl = String(process.env.ZAPI_URL || '').trim().replace(/\/$/, '');
  const client = String(process.env.ZAPI_CLIENT || '').trim();
  const publicUrl = String(process.env.PORTARIASYNC_PUBLIC_URL || 'https://portaria.clecius.tech').trim().replace(/\/$/, '');

  if (!zapiUrl || !client) throw new Error('ZAPI_URL e ZAPI_CLIENT precisam estar configurados no .env.');
  if (!/^https:\/\//i.test(publicUrl)) throw new Error('PORTARIASYNC_PUBLIC_URL precisa usar HTTPS.');

  const { secret, created } = ensureSecret();
  const deliveryUrl = `${publicUrl}/api/zapi/delivery?key=${encodeURIComponent(secret)}`;
  const statusUrl = `${publicUrl}/api/zapi/message-status?key=${encodeURIComponent(secret)}`;

  await putWebhook(`${zapiUrl}/update-webhook-delivery`, client, deliveryUrl);
  await putWebhook(`${zapiUrl}/update-webhook-message-status`, client, statusUrl);

  const meResponse = await fetch(`${zapiUrl}/me`, { headers: { 'Client-Token': client } });
  let me = {};
  try { me = await meResponse.json(); } catch (_) {}
  if (!meResponse.ok) throw new Error(`Z-API respondeu ${meResponse.status} ao validar configuração.`);

  console.log('Webhooks Z-API configurados com sucesso.');
  console.log('URL pública:', publicUrl);
  console.log('Segredo:', created ? 'gerado e salvo no .env' : 'já existente no .env');
  console.log('Delivery confirmado:', !!me.deliveryCallbackUrl);
  console.log('Message status confirmado:', !!me.messageStatusCallbackUrl);
  console.log('Nenhuma credencial foi exibida.');
})().catch(error => {
  console.error('Falha:', error.message);
  process.exitCode = 1;
});
