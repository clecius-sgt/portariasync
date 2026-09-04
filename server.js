const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PaddleOcrClient } = require('./paddle-ocr-client');
const { WhatsAppProvider } = require('./whatsapp-provider');
const { ResidentPortalService, finalizePackageAuthorizations } = require('./resident-portal-service');
const { AssociationManager, DEFAULT_ASSOCIATION_ID } = require('./association-manager');
const { OccurrenceService } = require('./occurrence-service');

loadEnv();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = __dirname;

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSION_MAX_AGE_MS = Number(process.env.SESSION_MAX_AGE_MS || 8 * 60 * 60 * 1000);
const sessions = new Map();
const paddleOcr = new PaddleOcrClient({ baseDir: __dirname });
const whatsapp = new WhatsAppProvider();
const associations = new AssociationManager({
  dataDir: DATA_DIR,
  defaultName: process.env.DEFAULT_ASSOCIATION_NAME || 'Associação de Moradores'
});
const database = associations.database(DEFAULT_ASSOCIATION_ID);
const occurrences = new OccurrenceService({ associations });

ensureUsersFile();

const residentPortal = new ResidentPortalService({
  readState: readAppState,
  writeState: writeAppState,
  sendText: (numero, mensagem) => whatsapp.sendText(numero, mensagem),
  defaultAssociationId: DEFAULT_ASSOCIATION_ID
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip'
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
  console.log('Multi-Associação ativa:', associations.status(false).total, 'associação(ões) cadastrada(s).');
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    paddleOcr.stop();
    try { associations.closeAll(); } catch (_) {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

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
    partes.includes('node_modules') ||
    path.basename(abs).toLowerCase() === 'index~1.htm' ||
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
  const ext = path.extname(abs).toLowerCase();
  const appDinamico = (ext === '.html' || ext === '.js') && !partes.includes('vendor');
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': appDinamico ? 'no-store, max-age=0' : 'public, max-age=86400'
  });
  fs.createReadStream(abs).pipe(res);
}

async function handleApi(req, res) {
  const requestUrl = new URL(req.url, 'http://localhost');
  const pathname = requestUrl.pathname;

  if (req.method === 'GET' && req.url === '/api/health') {
    const whats = whatsapp.status();
    sendJson(res, 200, {
      ok: true,
      supabase: !!(SUPABASE_URL && SUPABASE_SERVICE_KEY),
      whatsapp: whats.configured,
      whatsappProvider: whats,
      database: database.status(),
      multiAssociation: associations.status(false),
      residentPortal: residentPortal.status(),
      occurrences: occurrences.status(DEFAULT_ASSOCIATION_ID),
      paddleocr: paddleOcr.status()
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/database/status') {
    const session = requireRole(req, ['admin', 'supervisor']);
    sendJson(res, 200, {
      ok: true,
      association: associations.publicInfo(session.associacaoId),
      database: associations.database(session.associacaoId).status()
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/associations') {
    requirePlatformAdmin(req);
    sendJson(res, 200, { ok: true, multiAssociation: associations.status(true) });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/associations') {
    requirePlatformAdmin(req);
    const body = await readJson(req);
    const association = associations.create({ id: body.id, nome: body.nome || body.name });
    sendJson(res, 201, { ok: true, association: { id: association.id, nome: association.name } });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/associations/current') {
    const session = requireRole(req, ['admin', 'porteiro', 'supervisor']);
    sendJson(res, 200, { ok: true, association: associations.publicInfo(session.associacaoId), platformAdmin: session.plataforma === true });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/auth/switch-association') {
    const session = requirePlatformAdmin(req);
    const { associacaoId } = await readJson(req);
    const association = associations.require(associacaoId);
    session.associacaoId = association.id;
    sendJson(res, 200, { ok: true, user: publicUser(session) });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/morador/auth/request') {
    const { phone, associationId } = await readJson(req);
    const scoped = associations.require(associationId || DEFAULT_ASSOCIATION_ID);
    const result = await residentPortal.requestCode(phone, clientIp(req), scoped.id);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/morador/auth/verify') {
    const { challengeId, code } = await readJson(req);
    const result = await residentPortal.verify(challengeId, code);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'GET' && req.url === '/api/morador/me') {
    sendJson(res, 200, await residentPortal.profile(residentToken(req)));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/morador/encomendas') {
    sendJson(res, 200, await residentPortal.packages(residentToken(req)));
    return;
  }

  const residentAuthorizationMatch = req.url.match(/^\/api\/morador\/encomendas\/([^/]+)\/autorizacao$/);
  if (req.method === 'POST' && residentAuthorizationMatch) {
    const id = decodeURIComponent(residentAuthorizationMatch[1]);
    const body = await readJson(req);
    sendJson(res, 201, await residentPortal.authorizeThirdParty(residentToken(req), id, body));
    return;
  }
  if (req.method === 'DELETE' && residentAuthorizationMatch) {
    const id = decodeURIComponent(residentAuthorizationMatch[1]);
    sendJson(res, 200, await residentPortal.cancelThirdPartyAuthorization(residentToken(req), id));
    return;
  }

  const resendResidentPinMatch = req.url.match(/^\/api\/morador\/encomendas\/([^/]+)\/reenviar-pin$/);
  if (req.method === 'POST' && resendResidentPinMatch) {
    const id = decodeURIComponent(resendResidentPinMatch[1]);
    sendJson(res, 200, await residentPortal.resendPin(residentToken(req), id));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/morador/logout') {
    sendJson(res, 200, residentPortal.logout(residentToken(req)));
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
    const associacaoId = validUserAssociation(user);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, {
      id: user.id,
      nome: user.nome,
      perfil: user.perfil,
      associacaoId,
      plataforma: user.plataforma === true || user.id === 'u1',
      createdAt: Date.now()
    });
    sendJson(res, 200, { token, user: publicUser(sessions.get(token)) });
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
    const session = requireRole(req, ['admin']);
    const { nome, perfil, senha, associacaoId } = await readJson(req);
    if (!nome || !['admin', 'porteiro', 'supervisor'].includes(perfil) || !senha || String(senha).length < 4) {
      sendJson(res, 400, { error: 'Dados do usuário inválidos' });
      return;
    }
    const targetAssociation = session.plataforma === true
      ? associations.require(associacaoId || session.associacaoId).id
      : session.associacaoId;
    const users = readUsers();
    const user = {
      id: 'u' + Date.now(),
      nome,
      perfil,
      associacaoId: targetAssociation,
      plataforma: false,
      password: hashPassword(senha)
    };
    users.push(user);
    writeUsers(users);
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  const deleteUserMatch = req.url.match(/^\/api\/users\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteUserMatch) {
    const session = requireRole(req, ['admin']);
    const id = decodeURIComponent(deleteUserMatch[1]);
    if (id === 'u1') {
      sendJson(res, 400, { error: 'Usuário padrão não pode ser removido' });
      return;
    }
    const users = readUsers();
    const target = users.find(u => u.id === id);
    if (target && session.plataforma !== true && validUserAssociation(target) !== session.associacaoId) {
      sendJson(res, 403, { error: 'Usuário pertence a outra associação.' });
      return;
    }
    writeUsers(users.filter(u => u.id !== id));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/occurrences') {
    const session = requireRole(req, ['admin', 'porteiro', 'supervisor']);
    const result = occurrences.list(session.associacaoId, {
      status: requestUrl.searchParams.get('status') || '',
      priority: requestUrl.searchParams.get('priority') || '',
      type: requestUrl.searchParams.get('type') || '',
      packageId: requestUrl.searchParams.get('packageId') || '',
      q: requestUrl.searchParams.get('q') || ''
    });
    sendJson(res, 200, { ok:true, association:associations.publicInfo(session.associacaoId), ...result });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/occurrences') {
    const session = requireRole(req, ['admin', 'porteiro', 'supervisor']);
    const body = await readJson(req, 1024 * 1024);
    const result = occurrences.create(session.associacaoId, body, sessionActor(session, req));
    sendJson(res, 201, { ok:true, ...result });
    return;
  }

  const occurrenceAttachmentGet = pathname.match(/^\/api\/occurrences\/([^/]+)\/attachments\/([^/]+)$/);
  if (req.method === 'GET' && occurrenceAttachmentGet) {
    const session = requireRole(req, ['admin', 'porteiro', 'supervisor']);
    const occurrenceId = decodeURIComponent(occurrenceAttachmentGet[1]);
    const attachmentId = decodeURIComponent(occurrenceAttachmentGet[2]);
    const attachment = occurrences.getAttachment(session.associacaoId, occurrenceId, attachmentId);
    sendAttachment(res, attachment);
    return;
  }

  const occurrenceAttachmentPost = pathname.match(/^\/api\/occurrences\/([^/]+)\/attachments$/);
  if (req.method === 'POST' && occurrenceAttachmentPost) {
    const session = requireRole(req, ['admin', 'porteiro', 'supervisor']);
    const occurrenceId = decodeURIComponent(occurrenceAttachmentPost[1]);
    const body = await readJson(req, 4 * 1024 * 1024);
    const result = occurrences.addAttachment(session.associacaoId, occurrenceId, body, sessionActor(session, req));
    sendJson(res, 201, { ok:true, ...result });
    return;
  }

  const occurrenceNotesMatch = pathname.match(/^\/api\/occurrences\/([^/]+)\/notes$/);
  if (req.method === 'POST' && occurrenceNotesMatch) {
    const session = requireRole(req, ['admin', 'porteiro', 'supervisor']);
    const id = decodeURIComponent(occurrenceNotesMatch[1]);
    const body = await readJson(req);
    const result = occurrences.addNote(session.associacaoId, id, body, sessionActor(session, req));
    sendJson(res, 200, { ok:true, ...result });
    return;
  }

  const occurrencePriorityMatch = pathname.match(/^\/api\/occurrences\/([^/]+)\/priority$/);
  if (req.method === 'POST' && occurrencePriorityMatch) {
    const session = requireRole(req, ['admin', 'supervisor']);
    const id = decodeURIComponent(occurrencePriorityMatch[1]);
    const body = await readJson(req);
    const result = occurrences.setPriority(session.associacaoId, id, body.priority, sessionActor(session, req));
    sendJson(res, 200, { ok:true, ...result });
    return;
  }

  const occurrenceStatusMatch = pathname.match(/^\/api\/occurrences\/([^/]+)\/status$/);
  if (req.method === 'POST' && occurrenceStatusMatch) {
    const session = requireRole(req, ['admin', 'supervisor']);
    const id = decodeURIComponent(occurrenceStatusMatch[1]);
    const body = await readJson(req);
    const result = occurrences.setStatus(session.associacaoId, id, body.status, body.reason, sessionActor(session, req));
    sendJson(res, 200, { ok:true, ...result });
    return;
  }

  const occurrenceConcludeMatch = pathname.match(/^\/api\/occurrences\/([^/]+)\/conclude$/);
  if (req.method === 'POST' && occurrenceConcludeMatch) {
    const session = requireRole(req, ['admin']);
    const id = decodeURIComponent(occurrenceConcludeMatch[1]);
    const body = await readJson(req);
    const result = occurrences.conclude(session.associacaoId, id, body, sessionActor(session, req));
    sendJson(res, 200, { ok:true, ...result });
    return;
  }

  const occurrenceReopenMatch = pathname.match(/^\/api\/occurrences\/([^/]+)\/reopen$/);
  if (req.method === 'POST' && occurrenceReopenMatch) {
    const session = requireRole(req, ['admin']);
    const id = decodeURIComponent(occurrenceReopenMatch[1]);
    const body = await readJson(req);
    const result = occurrences.reopen(session.associacaoId, id, body.reason, sessionActor(session, req));
    sendJson(res, 200, { ok:true, ...result });
    return;
  }

  const occurrenceCancelMatch = pathname.match(/^\/api\/occurrences\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && occurrenceCancelMatch) {
    const session = requireRole(req, ['admin']);
    const id = decodeURIComponent(occurrenceCancelMatch[1]);
    const body = await readJson(req);
    const result = occurrences.cancel(session.associacaoId, id, body.reason, sessionActor(session, req));
    sendJson(res, 200, { ok:true, ...result });
    return;
  }

  const occurrenceDetailMatch = pathname.match(/^\/api\/occurrences\/([^/]+)$/);
  if (req.method === 'GET' && occurrenceDetailMatch) {
    const session = requireRole(req, ['admin', 'porteiro', 'supervisor']);
    const id = decodeURIComponent(occurrenceDetailMatch[1]);
    const result = occurrences.get(session.associacaoId, id);
    sendJson(res, 200, { ok:true, ...result });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/app-state') {
    const session = requireRole(req, ['admin', 'porteiro', 'supervisor']);
    sendJson(res, 200, await readAppState(session.associacaoId));
    return;
  }

  if (req.method === 'PUT' && req.url === '/api/app-state') {
    const session = requireRole(req, ['admin', 'porteiro']);
    const body = await readJson(req, 50 * 1024 * 1024);
    const atual = await readAppState(session.associacaoId);
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
    await writeAppState(session.associacaoId, state);
    sendJson(res, 200, { ok: true, version: state.version, updatedAt: state.updatedAt, storage: 'sqlite', associacaoId: session.associacaoId });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/withdrawal-authorization/verify') {
    const session = requireRole(req, ['admin', 'porteiro']);
    const body = await readJson(req);
    const result = await residentPortal.verifyThirdPartyAuthorization(
      session.associacaoId,
      body.packageId,
      { codigo: body.codigo, documento: body.documento },
      session
    );
    sendJson(res, 200, { ...result, validadaPor: session.nome || session.id });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sync-data') {
    requirePrincipalSession(req, ['admin', 'porteiro', 'supervisor']);
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
    requirePrincipalSession(req, ['admin', 'porteiro']);
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
    requirePrincipalSession(req, ['admin', 'porteiro']);
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

  if (req.method === 'GET' && req.url === '/api/ocr-paddle/status') {
    requireRole(req, ['admin', 'porteiro', 'supervisor']);
    sendJson(res, 200, { ok: true, paddleocr: paddleOcr.status() });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/ocr-paddle') {
    requireRole(req, ['admin', 'porteiro']);
    const { imagemBase64 } = await readJson(req, 14 * 1024 * 1024);
    if (!imagemBase64) {
      sendJson(res, 400, { error: 'Fotografia da etiqueta não enviada.' });
      return;
    }
    const result = await paddleOcr.recognize(imagemBase64);
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.url === '/api/ocr') {
    sendJson(res, 410, { error: 'Endpoint antigo. O leitor principal agora é PaddleOCR no VPS.' });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/whatsapp/status') {
    requireRole(req, ['admin', 'porteiro', 'supervisor']);
    sendJson(res, 200, { ok: true, whatsapp: whatsapp.status() });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/whatsapp/package') {
    requireRole(req, ['admin', 'porteiro']);
    const body = await readJson(req);
    const result = await whatsapp.sendPackage(body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/whatsapp/reminder') {
    requireRole(req, ['admin', 'porteiro']);
    const body = await readJson(req);
    const result = await whatsapp.sendReminder(body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/whatsapp/test') {
    requireRole(req, ['admin']);
    const { numero } = await readJson(req);
    const result = await whatsapp.sendTest(numero);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/whatsapp/text') {
    requireRole(req, ['admin', 'porteiro']);
    const { numero, mensagem } = await readJson(req);
    const result = await whatsapp.sendText(numero, mensagem);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/whatsapp/image') {
    requireRole(req, ['admin', 'porteiro']);
    const { numero, imagemBase64, caption } = await readJson(req, 10 * 1024 * 1024);
    const result = await whatsapp.sendImage(numero, imagemBase64, caption);
    sendJson(res, 200, result);
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

function ensureUsersFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) {
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    writeUsers([
      {
        id: 'u1',
        nome: 'Administrador',
        perfil: 'admin',
        associacaoId: DEFAULT_ASSOCIATION_ID,
        plataforma: true,
        password: hashPassword(adminPassword)
      }
    ]);
    return;
  }

  const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  let changed = false;
  for (const user of users) {
    if (!user.associacaoId || !associations.get(user.associacaoId)) {
      user.associacaoId = DEFAULT_ASSOCIATION_ID;
      changed = true;
    }
    if (user.id === 'u1' && user.plataforma !== true) {
      user.plataforma = true;
      changed = true;
    }
    if (user.id !== 'u1' && typeof user.plataforma !== 'boolean') {
      user.plataforma = false;
      changed = true;
    }
  }
  if (changed) writeUsers(users);
}

function readUsers() {
  ensureUsersFile();
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function writeUsers(users) {
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
}

function validUserAssociation(user) {
  const requested = String(user?.associacaoId || DEFAULT_ASSOCIATION_ID);
  return associations.get(requested)?.id || DEFAULT_ASSOCIATION_ID;
}

async function readAppState(associationId = DEFAULT_ASSOCIATION_ID) {
  const scoped = associations.require(associationId).id;
  try {
    const local = associations.readState(scoped);
    if (local.exists) return local;
  } catch (e) {
    console.warn('Banco SQLite indisponível para leitura na associação ' + scoped + ':', e.message);
  }

  if (scoped === DEFAULT_ASSOCIATION_ID && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    try {
      const rows = await supabaseRequest('/rest/v1/app_state?id=eq.main&select=*');
      if (Array.isArray(rows) && rows.length > 0) {
        const remote = {
          exists: true,
          ...(rows[0].state || {}),
          version: Number(rows[0].version || rows[0].state?.version || 0),
          updatedAt: rows[0].updated_at || rows[0].state?.updatedAt || null
        };
        associations.writeState(scoped, remote);
        return associations.readState(scoped);
      }
    } catch (e) {
      console.warn('App state no Supabase indisponível, usando armazenamento local:', e.message);
    }
  }

  return associations.readState(scoped);
}

async function writeAppState(associationId = DEFAULT_ASSOCIATION_ID, state) {
  if (state === undefined && associationId && typeof associationId === 'object') {
    state = associationId;
    associationId = DEFAULT_ASSOCIATION_ID;
  }
  const scoped = associations.require(associationId).id;
  const clean = { ...state };
  delete clean.associacao;
  associations.database(scoped).writeState(clean);

  let savedRemote = false;
  if (scoped === DEFAULT_ASSOCIATION_ID && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    try {
      await supabaseRequest('/rest/v1/app_state', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          id: 'main',
          version: clean.version,
          state: clean,
          updated_at: clean.updatedAt
        })
      });
      savedRemote = true;
    } catch (e) {
      console.warn('Não foi possível gravar app_state no Supabase; SQLite permanece como fonte principal:', e.message);
    }
  }

  associations.writeMirror(scoped, clean, savedRemote ? 'sqlite+supabase+json-mirror' : 'sqlite+json-mirror');
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
  if (Array.isArray(e.autorizacoesRetirada) && e.autorizacoesRetirada.length) score += 1;
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
  return Array.from(mapa.values()).map(item => finalizePackageAuthorizations(item));
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
  const associacaoId = validUserAssociation(user);
  const association = associations.get(associacaoId);
  return {
    id: user.id,
    nome: user.nome,
    perfil: user.perfil,
    associacaoId,
    associacaoNome: association?.name || 'Associação de Moradores',
    plataforma: user.plataforma === true || user.id === 'u1'
  };
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

function residentToken(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Resident ') ? auth.slice(9) : '';
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || '';
}

function sessionActor(session, req) {
  return {
    id: session?.id || '',
    name: session?.nome || 'PortalSync',
    role: session?.perfil || 'sistema',
    ip: clientIp(req)
  };
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
  associations.require(ativa.associacaoId || DEFAULT_ASSOCIATION_ID);
  return ativa;
}

function requirePlatformAdmin(req) {
  const session = requireRole(req, ['admin']);
  if (session.plataforma !== true) {
    const err = new Error('Acesso restrito ao administrador da plataforma.');
    err.statusCode = 403;
    throw err;
  }
  return session;
}

function requirePrincipalSession(req, roles) {
  const session = requireRole(req, roles);
  if (session.associacaoId !== DEFAULT_ASSOCIATION_ID) {
    const err = new Error('Integração remota legada disponível apenas para a associação principal.');
    err.statusCode = 409;
    throw err;
  }
  return session;
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

function sendAttachment(res, attachment) {
  const safeName = String(attachment?.fileName || 'anexo').replace(/["\\\r\n]/g, '_');
  res.writeHead(200, {
    'Content-Type': attachment?.mimeType || 'application/octet-stream',
    'Content-Length': attachment?.content?.length || 0,
    'Content-Disposition': `attachment; filename="${safeName}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Content-SHA256': attachment?.sha256 || ''
  });
  res.end(attachment.content);
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
