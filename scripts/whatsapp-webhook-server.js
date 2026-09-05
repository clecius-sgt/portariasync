#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WhatsAppDeliveryStore } = require('../whatsapp-delivery-store');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
loadEnv(ENV_FILE);

const HOST = '127.0.0.1';
const PORT = Math.max(1, Number(process.env.WHATSAPP_WEBHOOK_PORT || 3002));
const SECRET = ensureSecret();
const ZAPI_URL = String(process.env.ZAPI_URL || '').trim();
const EXPECTED_INSTANCE_ID = instanceIdFromUrl(ZAPI_URL);
const store = new WhatsAppDeliveryStore({
  filePath: String(process.env.WHATSAPP_TRACKING_DB || '').trim() || path.join(ROOT, 'data', 'whatsapp-delivery.sqlite')
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

function ensureSecret() {
  let secret = String(process.env.ZAPI_WEBHOOK_SECRET || '').trim();
  if (secret) return secret;
  secret = crypto.randomBytes(24).toString('hex');
  const existing = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(ENV_FILE, `${prefix}ZAPI_WEBHOOK_SECRET=${secret}\n`, { mode: 0o600 });
  try { fs.chmodSync(ENV_FILE, 0o600); } catch (_) {}
  process.env.ZAPI_WEBHOOK_SECRET = secret;
  return secret;
}

function instanceIdFromUrl(value) {
  const match = String(value || '').match(/\/instances\/([^/]+)\/token\//i);
  return match ? decodeURIComponent(match[1]) : '';
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length > 0 && aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function authorized(requestUrl) {
  return safeEqual(requestUrl.searchParams.get('key') || '', SECRET);
}

function validateInstance(payload) {
  if (!EXPECTED_INSTANCE_ID) return true;
  return String(payload?.instanceId || '') === EXPECTED_INSTANCE_ID;
}

async function requirePlatformAdmin(req) {
  const authorization = String(req.headers.authorization || '');
  if (!authorization.startsWith('Bearer ')) {
    const error = new Error('Autenticação administrativa necessária.');
    error.statusCode = 401;
    throw error;
  }

  let response;
  try {
    response = await fetch('http://127.0.0.1:3000/api/auth/me', {
      headers: { Authorization: authorization }
    });
  } catch (_) {
    const error = new Error('Servidor principal indisponível para validar a sessão.');
    error.statusCode = 503;
    throw error;
  }

  let payload = {};
  try { payload = await response.json(); } catch (_) {}
  if (!response.ok || !payload.user) {
    const error = new Error('Sessão administrativa inválida ou expirada.');
    error.statusCode = 401;
    throw error;
  }
  if (payload.user.perfil !== 'admin' || payload.user.plataforma !== true) {
    const error = new Error('Acesso restrito ao administrador da plataforma.');
    error.statusCode = 403;
    throw error;
  }
  return payload.user;
}

function readJson(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > limit) {
        reject(new Error('Payload muito grande'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (_) { reject(new Error('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${HOST}:${PORT}`);

    if (req.method === 'GET' && requestUrl.pathname === '/api/zapi/health') {
      sendJson(res, 200, {
        ok: true,
        secretConfigured: true,
        instanceConfigured: !!EXPECTED_INSTANCE_ID,
        tracking: store.summary()
      });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/zapi/admin/recent') {
      const user = await requirePlatformAdmin(req);
      const limit = requestUrl.searchParams.get('limit') || 100;
      sendJson(res, 200, {
        ok: true,
        user: {
          id: user.id,
          nome: user.nome,
          perfil: user.perfil,
          plataforma: true
        },
        tracking: store.summary(),
        messages: store.list(limit)
      });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/zapi/recent') {
      if (!authorized(requestUrl)) {
        sendJson(res, 403, { error: 'Acesso negado' });
        return;
      }
      const limit = requestUrl.searchParams.get('limit') || 25;
      sendJson(res, 200, { ok: true, tracking: store.summary(), messages: store.list(limit) });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/zapi/delivery') {
      if (!authorized(requestUrl)) {
        sendJson(res, 403, { error: 'Webhook não autorizado' });
        return;
      }
      const payload = await readJson(req);
      if (!validateInstance(payload) || String(payload.type || '') !== 'DeliveryCallback') {
        sendJson(res, 403, { error: 'Evento Z-API inválido' });
        return;
      }
      const result = store.handleDelivery(payload);
      sendJson(res, 200, { value: true, matched: result.matched === true });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/zapi/message-status') {
      if (!authorized(requestUrl)) {
        sendJson(res, 403, { error: 'Webhook não autorizado' });
        return;
      }
      const payload = await readJson(req);
      if (!validateInstance(payload) || String(payload.type || '') !== 'MessageStatusCallback') {
        sendJson(res, 403, { error: 'Evento Z-API inválido' });
        return;
      }
      const result = store.handleMessageStatus(payload);
      sendJson(res, 200, { value: true, matched: result.matched || 0 });
      return;
    }

    sendJson(res, 404, { error: 'Rota não encontrada' });
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || 'Falha ao processar webhook' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Webhook WhatsApp do PortariaSync ativo em http://${HOST}:${PORT}`);
  console.log('Segredo do webhook: configurado');
  console.log('Instância Z-API:', EXPECTED_INSTANCE_ID ? 'identificada' : 'não identificada');
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    try { store.close(); } catch (_) {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
