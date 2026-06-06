const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

loadEnv();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = __dirname;

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ZAPI_URL = process.env.ZAPI_URL || '';
const ZAPI_CLIENT = process.env.ZAPI_CLIENT || '';
const OCRSPACE_API_KEY = process.env.OCRSPACE_API_KEY || 'K85992490088957';
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const APP_STATE_FILE = path.join(DATA_DIR, 'app-state.json');
const SESSION_MAX_AGE_MS = Number(process.env.SESSION_MAX_AGE_MS || 8 * 60 * 60 * 1000);
const sessions = new Map();

ensureUsersFile();

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
    if (req.method === 'OPTIONS') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.url.startsWith('/api/')) {
      await handleApi(req, res);
      return;
    }
    serveStatic(req, res);
  } catch (err) {
    sendJson(res, err.statusCode || 500, { error: err.statusCode ? err.message : 'Erro interno', detail: err.message });
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
  const rel = path.relative(PUBLIC_DIR, abs);
  const partes = rel.split(path.sep);
  if (
    !abs.startsWith(PUBLIC_DIR) ||
    partes.includes('data') ||
    partes.some(p => p.startsWith('.')) ||
    path.basename(abs).toLowerCase() === 'package-lock.json'
  ) {
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

  if (req.method === 'GET' && req.url === '/api/users') {
    sendJson(res, 200, { users: publicUsers() });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/auth/login') {
    const { id, senha } = await readJson(req);
    const user = readUsers().find(u => u.id === id);
    if (!user || !verifyPassword(senha, user.password)) {
      sendJson(res, 401, { error: 'Usuário ou senha incorretos' });
      return;
    }
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { id: user.id, nome: user.nome, perfil: user.perfil, createdAt: Date.now() });
    sendJson(res, 200, { token, user: publicUser(user) });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/auth/me') {
    const session = requireRole(req, ['admin', 'porteiro', 'supervisor']);
    sendJson(res, 200, { user: publicUser(session) });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/auth/logout') {
    const token = bearerToken(req);
    if (token) sessions.delete(token);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/users') {
    requireRole(req, ['admin']);
    const { nome, perfil, senha } = await readJson(req);
    if (!nome || !['admin', 'porteiro', 'supervisor'].includes(perfil) || !senha || String(senha).length < 4) {
      sendJson(res, 400, { error: 'Dados do usuário inválidos' });
      return;
    }
    const users = readUsers();
    const user = { id: 'u' + Date.now(), nome, perfil, password: hashPassword(senha) };
    users.push(user);
    writeUsers(users);
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  const deleteUserMatch = req.url.match(/^\/api\/users\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteUserMatch) {
    requireRole(req, ['admin']);
    const id = decodeURIComponent(deleteUserMatch[1]);
    if (id === 'u1') {
      sendJson(res, 400, { error: 'Usuário padrão não pode ser removido' });
      return;
    }
    writeUsers(readUsers().filter(u => u.id !== id));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/app-state') {
    requireRole(req, ['admin', 'porteiro', 'supervisor']);
    sendJson(res, 200, await readAppState());
    return;
  }

  if (req.method === 'PUT' && req.url === '/api/app-state') {
    requireRole(req, ['admin', 'porteiro']);
    const body = await readJson(req, 50 * 1024 * 1024);
    const atual = await readAppState();
    const resetEncomendasAt = body.resetEncomendasAt || atual.resetEncomendasAt || null;
    const preservarReset = resetEncomendasAt && !body.resetEncomendasAt;
    const encomendasRecebidas = Array.isArray(body.encomendas) ? body.encomendas : [];
    const encomendasAtuais = Array.isArray(atual.encomendas) ? atual.encomendas : [];
    const retirantesRecebidos = Array.isArray(body.retirantesRelacionados) ? body.retirantesRelacionados : [];
    const retirantesAtuais = Array.isArray(atual.retirantesRelacionados) ? atual.retirantesRelacionados : [];
    const detalhesRecebidos = body.detalhesRetirada && typeof body.detalhesRetirada === 'object' ? body.detalhesRetirada : {};
    const detalhesAtuais = atual.detalhesRetirada && typeof atual.detalhesRetirada === 'object' ? atual.detalhesRetirada : {};
    const state = {
      version: Number(body.version || Date.now()),
      updatedAt: new Date().toISOString(),
      moradores: Array.isArray(body.moradores) ? body.moradores : [],
      encomendas: preservarReset ? encomendasAtuais : mergeEncomendas(encomendasAtuais, encomendasRecebidas),
      retirantesRelacionados: preservarReset ? retirantesAtuais : mergePorChave(retirantesAtuais, retirantesRecebidos, chaveRetirante),
      auditoria: Array.isArray(body.auditoria) ? body.auditoria : [],
      detalhesRetirada: preservarReset ? detalhesAtuais : { ...detalhesAtuais, ...detalhesRecebidos },
      memoriaRemetentes: body.memoriaRemetentes && typeof body.memoriaRemetentes === 'object' ? body.memoriaRemetentes : {},
      configPublica: body.configPublica && typeof body.configPublica === 'object' ? body.configPublica : {},
      resetEncomendasAt
    };
    await writeAppState(state);
    sendJson(res, 200, { ok: true, version: state.version, updatedAt: state.updatedAt });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sync-data') {
    requireRole(req, ['admin', 'porteiro', 'supervisor']);
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
    requireRole(req, ['admin', 'porteiro']);
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
    requireRole(req, ['admin', 'porteiro']);
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

  if (req.method === 'POST' && req.url === '/api/ocr') {
    requireRole(req, ['admin', 'porteiro']);
    const { base64Image, language = 'por' } = await readJson(req, 12 * 1024 * 1024);
    if (!base64Image) {
      sendJson(res, 400, { error: 'Imagem não informada' });
      return;
    }
    const formData = new FormData();
    formData.append('base64Image', base64Image);
    formData.append('language', language);
    formData.append('isOverlayRequired', 'false');
    formData.append('detectOrientation', 'true');
    formData.append('scale', 'true');
    formData.append('OCREngine', '2');

    const resp = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { apikey: OCRSPACE_API_KEY },
      body: formData
    });
    const text = await resp.text();
    res.writeHead(resp.ok ? 200 : 502, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(text || '{}');
    return;
  }

  if (req.method === 'POST' && req.url === '/api/whatsapp/text') {
    requireRole(req, ['admin', 'porteiro']);
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
    requireRole(req, ['admin', 'porteiro']);
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

function ensureUsersFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(USERS_FILE)) return;
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  writeUsers([
    { id: 'u1', nome: 'Administrador', perfil: 'admin', password: hashPassword(adminPassword) }
  ]);
}

function readUsers() {
  ensureUsersFile();
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

async function readAppState() {
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    try {
      const rows = await supabaseRequest('/rest/v1/app_state?id=eq.main&select=*');
      if (Array.isArray(rows) && rows.length > 0) {
        return {
          exists: true,
          ...(rows[0].state || {}),
          version: Number(rows[0].version || rows[0].state?.version || 0),
          updatedAt: rows[0].updated_at || rows[0].state?.updatedAt || null,
          storage: 'supabase'
        };
      }
    } catch (e) {
      console.warn('App state no Supabase indisponível, usando arquivo local:', e.message);
    }
  }

  if (!fs.existsSync(APP_STATE_FILE)) return { exists: false, version: 0, updatedAt: null, storage: 'local' };
  return { exists: true, ...JSON.parse(fs.readFileSync(APP_STATE_FILE, 'utf8')), storage: 'local' };
}

async function writeAppState(state) {
  let savedRemote = false;
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    try {
      await supabaseRequest('/rest/v1/app_state', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          id: 'main',
          version: state.version,
          state,
          updated_at: state.updatedAt
        })
      });
      savedRemote = true;
    } catch (e) {
      console.warn('Não foi possível gravar app_state no Supabase, salvando local:', e.message);
    }
  }

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = APP_STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...state, storage: savedRemote ? 'supabase+local' : 'local' }, null, 2));
  fs.renameSync(tmp, APP_STATE_FILE);
  return savedRemote;
}

function scoreEncomenda(e) {
  let score = 1;
  if (!e) return 0;
  if (e.status === 'pendente') score += 2;
  if (e.status === 'cancelado') score += 4;
  if (e.status === 'retirado') score += 6;
  if (e.dataRetirada) score += 2;
  if (e.retiradoPor) score += 1;
  if (e.assinatura) score += 2;
  if (e.fotoRetirante) score += 2;
  return score;
}

function mergeEncomendas(base, recebidas) {
  const mapa = new Map();
  for (const e of base || []) if (e && e.id) mapa.set(String(e.id), e);
  for (const e of recebidas || []) {
    if (!e || !e.id) continue;
    const id = String(e.id);
    const atual = mapa.get(id);
    if (!atual || scoreEncomenda(e) >= scoreEncomenda(atual)) mapa.set(id, { ...atual, ...e });
  }
  return Array.from(mapa.values());
}

function chaveRetirante(r) {
  return [r?.moradorId || '', String(r?.rg || '').replace(/\D/g, ''), String(r?.nome || '').toLowerCase()].join('|');
}

function mergePorChave(base, recebidas, chaveFn) {
  const mapa = new Map();
  for (const item of base || []) mapa.set(chaveFn(item), item);
  for (const item of recebidas || []) {
    const chave = chaveFn(item);
    mapa.set(chave, { ...(mapa.get(chave) || {}), ...item });
  }
  return Array.from(mapa.values()).filter(item => item && Object.keys(item).length);
}

function publicUser(user) {
  return { id: user.id, nome: user.nome, perfil: user.perfil };
}

function publicUsers() {
  return readUsers().map(publicUser);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return `pbkdf2$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [algo, salt, hash] = String(stored || '').split('$');
  if (algo !== 'pbkdf2' || !salt || !hash) return false;
  const test = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
}

function bearerToken(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

function requireRole(req, roles) {
  const token = bearerToken(req);
  const session = token ? sessions.get(token) : null;
  if (session && Date.now() - session.createdAt > SESSION_MAX_AGE_MS) {
    sessions.delete(token);
  }
  const ativa = token ? sessions.get(token) : null;
  if (!ativa || !roles.includes(ativa.perfil)) {
    const err = new Error('Sem permissão');
    err.statusCode = 403;
    throw err;
  }
  return ativa;
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
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  });
  res.end(JSON.stringify(payload));
}
