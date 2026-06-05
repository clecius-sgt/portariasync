const http = require('http');
const fs = require('fs');
const path = require('path');

loadEnv();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = __dirname;

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ZAPI_URL = process.env.ZAPI_URL || '';
const ZAPI_CLIENT = process.env.ZAPI_CLIENT || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) {
      await handleApi(req, res);
      return;
    }
    serveStatic(req, res);
  } catch (err) {
    sendJson(res, 500, { error: 'Erro interno', detail: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`PortariaSync rodando em http://localhost:${PORT}`);
});

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

function serveStatic(req, res) {
  const rawPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = rawPath === '/' ? '/index.html' : rawPath;
  const abs = path.resolve(PUBLIC_DIR, '.' + filePath);
  if (!abs.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Acesso negado');
    return;
  }
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404);
    res.end('Arquivo não encontrado');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(abs).pipe(res);
}

async function handleApi(req, res) {
  if (req.method === 'GET' && req.url === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      supabase: !!(SUPABASE_URL && SUPABASE_SERVICE_KEY),
      whatsapp: !!(ZAPI_URL && ZAPI_CLIENT)
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sync-data') {
    requireSupabase();
    const [encomendas, moradores, remetentes] = await Promise.all([
      supabaseRequest('/rest/v1/encomendas?select=*&order=created_at.desc'),
      supabaseRequest('/rest/v1/moradores?select=*'),
      supabaseRequest('/rest/v1/remetentes?select=*')
    ]);
    sendJson(res, 200, { encomendas, moradores, remetentes });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/encomendas') {
    requireSupabase();
    const body = await readJson(req);
    await supabaseRequest('/rest/v1/encomendas', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(body)
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/remetentes') {
    requireSupabase();
    const body = await readJson(req);
    await supabaseRequest('/rest/v1/remetentes', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(body)
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/whatsapp/text') {
    requireWhatsapp();
    const { numero, mensagem } = await readJson(req);
    const destino = normalizarTelefone(numero);
    const resp = await fetch(`${ZAPI_URL}/send-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Client-Token': ZAPI_CLIENT },
      body: JSON.stringify({ phone: destino, message: mensagem })
    });
    sendJson(res, resp.ok ? 200 : 502, { ok: resp.ok, status: resp.status });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/whatsapp/image') {
    requireWhatsapp();
    const { numero, imagemBase64, caption } = await readJson(req, 10 * 1024 * 1024);
    const destino = normalizarTelefone(numero);
    const base64 = String(imagemBase64 || '').replace(/^data:image\/\w+;base64,/, '');
    const resp = await fetch(`${ZAPI_URL}/send-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Client-Token': ZAPI_CLIENT },
      body: JSON.stringify({ phone: destino, image: 'data:image/jpeg;base64,' + base64, caption })
    });
    sendJson(res, resp.ok ? 200 : 502, { ok: resp.ok, status: resp.status });
    return;
  }

  sendJson(res, 404, { error: 'Rota não encontrada' });
}

function requireSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    const err = new Error('Supabase não configurado no .env');
    err.statusCode = 503;
    throw err;
  }
}

function requireWhatsapp() {
  if (!ZAPI_URL || !ZAPI_CLIENT) {
    const err = new Error('WhatsApp/Z-API não configurado no .env');
    err.statusCode = 503;
    throw err;
  }
}

async function supabaseRequest(endpoint, options = {}) {
  const resp = await fetch(SUPABASE_URL + endpoint, {
    method: options.method || 'GET',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body
  });
  if (!resp.ok) throw new Error(`Supabase respondeu ${resp.status}`);
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

function normalizarTelefone(numero) {
  const num = String(numero || '').replace(/\D/g, '');
  return num.startsWith('55') ? num : '55' + num;
}

function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (Buffer.byteLength(data) > limit) {
        reject(new Error('Payload muito grande'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(payload));
}
