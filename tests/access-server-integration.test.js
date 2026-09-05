'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function startServer(port, dataDirectory, password) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      PORTARIASYNC_DATA_DIR: dataDirectory,
      ADMIN_PASSWORD: password,
      PADDLE_OCR_PREWARM: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk.toString(); });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Servidor encerrou durante a inicialização: ${errors}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return child;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error(`Servidor não ficou disponível: ${errors}`);
}

function stopServer(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 3000).unref();
  });
}

async function request(port, route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  return { status: response.status, body: await response.json() };
}

test('API autentica pelo SQLite e preserva sessão após reiniciar o servidor', { timeout: 20_000 }, async () => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'portariasync-server-access-'));
  const password = 'AdminTeste123';
  const port = await availablePort();
  let child;
  try {
    child = await startServer(port, dataDirectory, password);
    const users = await request(port, '/api/users');
    assert.equal(users.status, 200);
    assert.equal(users.body.users[0].id, 'u1');

    const login = await request(port, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ id: 'u1', senha: password })
    });
    assert.equal(login.status, 200);
    assert.match(login.body.token, /^[a-f0-9]{64}$/);
    const authorization = { Authorization: `Bearer ${login.body.token}` };

    const overview = await request(port, '/api/access/overview', { headers: authorization });
    assert.equal(overview.status, 200);
    assert.equal(overview.body.summary.ativos, 1);
    assert.equal(overview.body.summary.sessoesAtivas, 1);

    const dashboard = await request(port, '/api/dashboard/operational?tzOffset=-180', { headers: authorization });
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.body.association.id, 'principal');
    assert.equal(dashboard.body.summary.pending, 0);
    assert.equal(dashboard.body.serviceStatus.database, true);

    const initialState = await request(port, '/api/app-state', {
      method: 'PUT',
      headers: authorization,
      body: JSON.stringify({
        version: Date.now(),
        moradores: [{ id: 'm1', nome: 'Ana Teste', casa: 'Rua Brasil, 10', whats: '11999999999' }],
        encomendas: [{ id: 'p1', codigo: 'AB123456', status: 'pendente', moradorId: 'm1', moradorNome: 'Ana Teste', moradorCasa: 'Rua Brasil, 10', dataEntrada: '05/09/2026, 10:00:00' }],
        retirantesRelacionados: [],
        auditoria: [],
        detalhesRetirada: {},
        memoriaRemetentes: {},
        configPublica: {}
      })
    });
    assert.equal(initialState.status, 200);

    const packages = await request(port, '/api/packages/management?status=pendente', { headers: authorization });
    assert.equal(packages.status, 200);
    assert.equal(packages.body.summary.pending, 1);
    assert.equal(packages.body.packages[0].code, 'AB123456');

    const corrected = await request(port, '/api/packages/management/p1', {
      method: 'PATCH',
      headers: authorization,
      body: JSON.stringify({ expectedVersion: packages.body.version, code: 'XY987654', residentId: 'm1', carrier: 'Correios', reason: 'Correção para teste integrado' })
    });
    assert.equal(corrected.status, 200);
    assert.equal(corrected.body.package.code, 'XY987654');
    assert.ok(corrected.body.package.timeline.some(item => item.type === 'package_data_corrected'));

    const cancelled = await request(port, '/api/packages/management/p1/cancel', {
      method: 'POST',
      headers: authorization,
      body: JSON.stringify({ expectedVersion: corrected.body.version, reason: 'Cancelamento para teste integrado' })
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.package.status, 'cancelado');

    const reopened = await request(port, '/api/packages/management/p1/reopen', {
      method: 'POST',
      headers: authorization,
      body: JSON.stringify({ expectedVersion: cancelled.body.version, reason: 'Reabertura para teste integrado' })
    });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.package.status, 'pendente');
    assert.ok(reopened.body.package.timeline.some(item => item.type === 'package_reopened'));

    await stopServer(child);
    child = await startServer(port, dataDirectory, password);
    const restored = await request(port, '/api/auth/me', { headers: authorization });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.user.id, 'u1');

    const logout = await request(port, '/api/auth/logout', { method: 'POST', headers: authorization, body: '{}' });
    assert.equal(logout.status, 200);
    const denied = await request(port, '/api/auth/me', { headers: authorization });
    assert.equal(denied.status, 403);
  } finally {
    await stopServer(child);
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});
