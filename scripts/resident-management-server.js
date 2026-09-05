#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { AssociationManager, DEFAULT_ASSOCIATION_ID } = require('../association-manager');
const { ResidentManagementService } = require('../resident-management-service');

const ROOT = path.resolve(__dirname, '..');
loadEnv(path.join(ROOT, '.env'));

const HOST = '127.0.0.1';
const PORT = Math.max(1, Number(process.env.RESIDENT_MANAGEMENT_PORT || 3003));
const DATA_DIR = path.join(ROOT, 'data');
const associations = new AssociationManager({
  dataDir: DATA_DIR,
  defaultName: process.env.DEFAULT_ASSOCIATION_NAME || 'Associação de Moradores'
});
const residents = new ResidentManagementService({ associations });

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

async function requireAdmin(req) {
  const authorization = String(req.headers.authorization || '');
  if (!authorization.startsWith('Bearer ')) {
    const error = new Error('Autenticação administrativa necessária.');
    error.statusCode = 401;
    throw error;
  }
  let response;
  try {
    response = await fetch('http://127.0.0.1:3000/api/auth/me', { headers: { Authorization: authorization } });
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
  if (payload.user.perfil !== 'admin') {
    const error = new Error('Acesso restrito ao administrador.');
    error.statusCode = 403;
    throw error;
  }
  associations.ensureRegistry();
  const associationId = payload.user.associacaoId || DEFAULT_ASSOCIATION_ID;
  associations.require(associationId);
  return { ...payload.user, associacaoId: associationId };
}

function actor(user, req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return {
    id: user.id,
    name: user.nome,
    role: user.perfil,
    ip: forwarded || req.socket?.remoteAddress || ''
  };
}

function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > limit) {
        const error = new Error('Payload muito grande.');
        error.statusCode = 413;
        reject(error);
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (_) {
        const error = new Error('JSON inválido.');
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function errorPayload(error) {
  const payload = { error: error.message || 'Falha na gestão de moradores.' };
  if (error.code) payload.code = error.code;
  if (error.duplicates) payload.duplicates = error.duplicates;
  if (error.pendingPackages) payload.pendingPackages = error.pendingPackages;
  if (error.preview) payload.preview = error.preview;
  return payload;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/api/residents/health') {
      sendJson(res, 200, { ok: true, service: 'resident-management', multiAssociation: true });
      return;
    }

    const user = await requireAdmin(req);
    const associationId = user.associacaoId;
    const userActor = actor(user, req);

    if (req.method === 'GET' && pathname === '/api/residents') {
      sendJson(res, 200, { ok: true, ...residents.list(associationId) });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/residents') {
      const body = await readJson(req);
      const result = residents.create(associationId, body, userActor);
      sendJson(res, 201, { ok: true, ...result });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/residents/import/preview') {
      const body = await readJson(req, 4 * 1024 * 1024);
      const preview = residents.prepareImport(associationId, body.rows || [], { allowSharedPhone: body.allowSharedPhone === true });
      sendJson(res, 200, { ok: true, association: associations.publicInfo(associationId), preview });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/residents/import') {
      const body = await readJson(req, 4 * 1024 * 1024);
      if (body.confirm !== true) {
        sendJson(res, 400, { error: 'Confirmação explícita da importação é obrigatória.' });
        return;
      }
      const result = residents.importRows(associationId, body.rows || [], { allowSharedPhone: body.allowSharedPhone === true }, userActor);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    const deactivateMatch = pathname.match(/^\/api\/residents\/([^/]+)\/deactivate$/);
    if (req.method === 'POST' && deactivateMatch) {
      const body = await readJson(req);
      const id = decodeURIComponent(deactivateMatch[1]);
      const result = residents.deactivate(associationId, id, body.reason || body.motivo, userActor);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    const reactivateMatch = pathname.match(/^\/api\/residents\/([^/]+)\/reactivate$/);
    if (req.method === 'POST' && reactivateMatch) {
      const body = await readJson(req);
      const id = decodeURIComponent(reactivateMatch[1]);
      const result = residents.reactivate(associationId, id, userActor, { allowSharedPhone: body.allowSharedPhone === true });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    const residentMatch = pathname.match(/^\/api\/residents\/([^/]+)$/);
    if (req.method === 'PUT' && residentMatch) {
      const body = await readJson(req);
      const id = decodeURIComponent(residentMatch[1]);
      const result = residents.update(associationId, id, body, userActor);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    sendJson(res, 404, { error: 'Rota não encontrada.' });
  } catch (error) {
    sendJson(res, error.statusCode || 400, errorPayload(error));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Gestão de Moradores ativa em http://${HOST}:${PORT}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    try { associations.closeAll(); } catch (_) {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
