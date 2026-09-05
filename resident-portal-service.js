'use strict';

const crypto = require('crypto');

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeLocalPhone(value) {
  const raw = digits(value);
  return raw.length === 10 || raw.length === 11 ? raw : '';
}

function phoneVariants(value) {
  const raw = digits(value);
  const variants = new Set();
  if (!raw) return variants;
  variants.add(raw);
  if ((raw.length === 10 || raw.length === 11) && !raw.startsWith('55')) variants.add('55' + raw);
  if (raw.startsWith('55') && (raw.length === 12 || raw.length === 13)) variants.add(raw.slice(2));
  return variants;
}

function phonesMatch(a, b) {
  const aa = phoneVariants(a);
  const bb = phoneVariants(b);
  for (const value of aa) if (bb.has(value)) return true;
  return false;
}

function maskPhone(value) {
  const raw = digits(value);
  if (!raw) return '';
  return '***' + raw.slice(-4);
}

function normalizeDocument(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 30);
}

function maskDocument(value) {
  const normalized = normalizeDocument(value);
  if (!normalized) return '';
  return '***' + normalized.slice(-4);
}

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 120);
}

function authorizationRecords(item) {
  const list = Array.isArray(item?.autorizacoesRetirada) ? item.autorizacoesRetirada.filter(Boolean) : [];
  if (!list.length && item?.autorizacaoRetirada && typeof item.autorizacaoRetirada === 'object') list.push(item.autorizacaoRetirada);
  return list;
}

function authorizationStatus(record, now = Date.now()) {
  if (!record) return 'inexistente';
  const explicit = String(record.status || 'ativa').toLowerCase();
  if (explicit !== 'ativa') return explicit;
  const expires = Date.parse(record.expiraEm || '');
  if (Number.isFinite(expires) && expires <= Number(now)) return 'expirada';
  return 'ativa';
}

function latestAuthorization(item) {
  const list = authorizationRecords(item);
  if (!list.length) return null;
  return list.slice().sort((a, b) => Date.parse(b.criadaEm || 0) - Date.parse(a.criadaEm || 0))[0] || null;
}

function activeAuthorization(item, now = Date.now()) {
  return authorizationRecords(item)
    .filter(record => authorizationStatus(record, now) === 'ativa')
    .sort((a, b) => Date.parse(b.criadaEm || 0) - Date.parse(a.criadaEm || 0))[0] || null;
}

function authorizationSummary(record, now = Date.now()) {
  if (!record) return null;
  return {
    id: String(record.id || ''),
    nome: String(record.nome || ''),
    documentoMascarado: maskDocument(record.documento),
    criadaEm: record.criadaEm || null,
    expiraEm: record.expiraEm || null,
    status: authorizationStatus(record, now),
    validadaEm: record.validadaEm || null,
    utilizadaEm: record.utilizadaEm || null,
    canceladaEm: record.canceladaEm || null
  };
}

function cleanPackage(item, now = Date.now()) {
  const latest = latestAuthorization(item);
  return {
    id: String(item?.id || ''),
    codigo: String(item?.codigo || ''),
    transportadora: String(item?.transportadora || ''),
    status: String(item?.status || ''),
    dataEntrada: item?.dataEntrada || null,
    dataRetirada: item?.dataRetirada || null,
    moradorId: String(item?.moradorId || ''),
    moradorNome: String(item?.moradorNome || ''),
    moradorCasa: String(item?.moradorCasa || ''),
    observacao: String(item?.obs || ''),
    pinAtivo: /^\d{6}$/.test(String(item?.pinRetirada || '')) && item?.pinRetiradaEnviado === true,
    autorizacaoTerceiro: authorizationSummary(latest, now)
  };
}

function statusError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function appendAudit(state, action, fields = {}, at = new Date()) {
  if (!Array.isArray(state.auditoria)) state.auditoria = [];
  state.auditoria.push({
    acao: action,
    data: at.toISOString(),
    usuario: fields.usuario || 'Portal do Morador',
    ...fields
  });
}

function authorizationHash(code, salt) {
  return crypto.scryptSync(String(code || ''), String(salt || ''), 32).toString('hex');
}

function safeHashEqual(actualHex, expectedHex) {
  try {
    const actual = Buffer.from(String(actualHex || ''), 'hex');
    const expected = Buffer.from(String(expectedHex || ''), 'hex');
    return actual.length > 0 && actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

function finalizePackageAuthorizations(item, now = Date.now()) {
  if (!item || String(item.status || '') !== 'retirado') return item;
  const records = authorizationRecords(item);
  if (!records.length) return item;
  const when = item.dataRetirada || new Date(now).toISOString();
  for (const record of records) {
    if (String(record.status || 'ativa').toLowerCase() !== 'ativa') continue;
    if (record.validadaEm) {
      record.status = 'utilizada';
      record.utilizadaEm = record.utilizadaEm || when;
    } else {
      record.status = 'encerrada';
      record.encerradaEm = record.encerradaEm || when;
    }
  }
  item.autorizacoesRetirada = records;
  delete item.autorizacaoRetirada;
  return item;
}

class ResidentPortalService {
  constructor(options = {}) {
    if (typeof options.readState !== 'function') throw new Error('readState é obrigatório.');
    if (typeof options.writeState !== 'function') throw new Error('writeState é obrigatório.');
    if (typeof options.sendText !== 'function') throw new Error('sendText é obrigatório.');
    this.readState = options.readState;
    this.writeState = options.writeState;
    this.sendText = options.sendText;
    this.defaultAssociationId = String(options.defaultAssociationId || 'principal');
    this.now = options.now || (() => Date.now());
    this.randomBytes = options.randomBytes || (size => crypto.randomBytes(size));
    this.codeGenerator = options.codeGenerator || (() => String(100000 + (this.randomBytes(4).readUInt32BE(0) % 900000)));
    this.authorizationCodeGenerator = options.authorizationCodeGenerator || this.codeGenerator;
    this.otpTtlMs = Number(options.otpTtlMs || 10 * 60 * 1000);
    this.sessionTtlMs = Number(options.sessionTtlMs || 12 * 60 * 60 * 1000);
    this.cooldownMs = Number(options.cooldownMs || 60 * 1000);
    this.maxAttempts = Number(options.maxAttempts || 5);
    this.authorizationMaxAttempts = Number(options.authorizationMaxAttempts || 5);
    this.challenges = new Map();
    this.sessions = new Map();
    this.cooldowns = new Map();
  }

  token(size = 24) {
    return this.randomBytes(size).toString('hex');
  }

  hash(challengeId, code) {
    return crypto.createHash('sha256').update(String(challengeId) + ':' + String(code)).digest('hex');
  }

  cleanup() {
    const now = this.now();
    for (const [key, value] of this.challenges) if (value.expiresAt <= now) this.challenges.delete(key);
    for (const [key, value] of this.sessions) if (value.expiresAt <= now) this.sessions.delete(key);
    for (const [key, value] of this.cooldowns) if (value <= now) this.cooldowns.delete(key);
  }

  status() {
    this.cleanup();
    return {
      enabled: true,
      multiAssociation: true,
      thirdPartyAuthorization: true,
      phoneInput: 'ddd-number',
      otpTtlMinutes: Math.round(this.otpTtlMs / 60000),
      sessionHours: Math.round(this.sessionTtlMs / 3600000),
      activeSessions: this.sessions.size
    };
  }

  async requestCode(phone, ip = '', associationId = this.defaultAssociationId) {
    this.cleanup();
    const informed = normalizeLocalPhone(phone);
    if (!informed) throw statusError('Informe apenas o DDD e o número do WhatsApp, sem +55.', 400);
    const scopedAssociationId = String(associationId || this.defaultAssociationId);

    const challengeId = this.token(16);
    const state = await this.readState(scopedAssociationId);
    const residents = (state?.moradores || []).filter(item => phonesMatch(item?.whats, informed));
    const residentIds = residents.map(item => String(item.id));
    const challenge = {
      id: challengeId,
      associationId: scopedAssociationId,
      phone: informed,
      residentIds,
      codeHash: null,
      expiresAt: this.now() + this.otpTtlMs,
      attempts: 0
    };

    const cooldownKey = scopedAssociationId + '|' + informed + '|' + String(ip || '');
    const blockedUntil = this.cooldowns.get(cooldownKey) || 0;
    if (blockedUntil > this.now()) throw statusError('Aguarde um minuto antes de solicitar outro código.', 429);
    this.cooldowns.set(cooldownKey, this.now() + this.cooldownMs);

    if (residents.length) {
      const code = this.codeGenerator();
      challenge.codeHash = this.hash(challengeId, code);
      const target = residents[0].whats;
      await this.sendText(target,
        'PortalSync - código de acesso ao Portal do Morador: ' + code + '.\n' +
        'Válido por 10 minutos. Não compartilhe este código.'
      );
    }

    this.challenges.set(challengeId, challenge);
    return {
      ok: true,
      challengeId,
      message: 'Se o número estiver cadastrado nesta associação, enviaremos um código de acesso pelo WhatsApp.'
    };
  }

  async verify(challengeId, code) {
    this.cleanup();
    const challenge = this.challenges.get(String(challengeId || ''));
    if (!challenge || challenge.expiresAt <= this.now()) throw statusError('Código expirado. Solicite um novo.', 401);
    challenge.attempts++;
    if (challenge.attempts > this.maxAttempts) {
      this.challenges.delete(challenge.id);
      throw statusError('Muitas tentativas. Solicite um novo código.', 429);
    }
    const valid = challenge.codeHash && this.hash(challenge.id, String(code || '').replace(/\D/g, '')) === challenge.codeHash;
    if (!valid || !challenge.residentIds.length) throw statusError('Código inválido.', 401);

    const token = this.token(32);
    this.sessions.set(token, {
      token,
      associationId: challenge.associationId || this.defaultAssociationId,
      residentIds: [...challenge.residentIds],
      phone: challenge.phone,
      createdAt: this.now(),
      expiresAt: this.now() + this.sessionTtlMs
    });
    this.challenges.delete(challenge.id);
    return { ok: true, token, expiresInSeconds: Math.round(this.sessionTtlMs / 1000) };
  }

  requireSession(token) {
    this.cleanup();
    const session = this.sessions.get(String(token || ''));
    if (!session || session.expiresAt <= this.now()) throw statusError('Sessão expirada. Entre novamente.', 401);
    return session;
  }

  async profile(token) {
    const session = this.requireSession(token);
    const state = await this.readState(session.associationId || this.defaultAssociationId);
    const residents = (state?.moradores || []).filter(item => session.residentIds.includes(String(item?.id || '')));
    const packages = (state?.encomendas || []).filter(item => session.residentIds.includes(String(item?.moradorId || '')));
    return {
      ok: true,
      association: state?.associacao || { id: session.associationId || this.defaultAssociationId },
      phone: maskPhone(session.phone),
      residents: residents.map(item => ({ id: String(item.id), nome: item.nome || '', casa: item.casa || '' })),
      summary: {
        pendentes: packages.filter(item => item.status === 'pendente').length,
        retiradas: packages.filter(item => item.status === 'retirado').length,
        total: packages.length
      }
    };
  }

  async packages(token) {
    const session = this.requireSession(token);
    const state = await this.readState(session.associationId || this.defaultAssociationId);
    const now = this.now();
    const packages = (state?.encomendas || [])
      .filter(item => session.residentIds.includes(String(item?.moradorId || '')))
      .map(item => cleanPackage(item, now));
    return { ok: true, associationId: session.associationId || this.defaultAssociationId, packages };
  }

  ownedPendingPackage(state, session, packageId) {
    const item = (state?.encomendas || []).find(pkg => String(pkg?.id || '') === String(packageId || ''));
    if (!item || !session.residentIds.includes(String(item.moradorId || ''))) throw statusError('Encomenda não encontrada.', 404);
    if (String(item.status || '') !== 'pendente') throw statusError('Esta encomenda não está mais pendente.', 409);
    return item;
  }

  async authorizeThirdParty(token, packageId, input = {}) {
    const session = this.requireSession(token);
    const associationId = session.associationId || this.defaultAssociationId;
    const state = await this.readState(associationId);
    const item = this.ownedPendingPackage(state, session, packageId);
    const resident = (state?.moradores || []).find(m => String(m?.id || '') === String(item.moradorId || ''));
    if (!resident || !phonesMatch(resident.whats, session.phone)) throw statusError('Contato do morador não confere com a sessão.', 403);

    const nome = normalizeName(input.nome || input.name);
    const documento = normalizeDocument(input.documento || input.document);
    if (nome.length < 3) throw statusError('Informe o nome completo da pessoa autorizada.', 400);
    if (documento.length < 4) throw statusError('Informe um documento válido da pessoa autorizada.', 400);
    const requestedHours = Number(input.validadeHoras || input.validityHours || 24);
    const validityHours = Number.isFinite(requestedHours) ? Math.max(1, Math.min(72, Math.round(requestedHours))) : 24;
    const now = this.now();

    const records = authorizationRecords(item);
    for (const record of records) {
      if (authorizationStatus(record, now) === 'ativa') {
        record.status = 'substituida';
        record.substituidaEm = new Date(now).toISOString();
      }
    }

    const code = String(this.authorizationCodeGenerator()).replace(/\D/g, '').slice(0, 6);
    if (!/^\d{6}$/.test(code)) throw new Error('Gerador de código de autorização inválido.');
    const salt = this.randomBytes(16).toString('hex');
    const record = {
      id: 'atr-' + now + '-' + this.token(4),
      nome,
      documento,
      status: 'ativa',
      criadaEm: new Date(now).toISOString(),
      expiraEm: new Date(now + validityHours * 60 * 60 * 1000).toISOString(),
      validadeHoras: validityHours,
      codigoSalt: salt,
      codigoHash: authorizationHash(code, salt),
      tentativasInvalidas: 0,
      moradorId: String(item.moradorId || '')
    };
    records.push(record);
    item.autorizacoesRetirada = records;
    delete item.autorizacaoRetirada;
    state.version = Date.now();
    state.updatedAt = new Date(now).toISOString();
    appendAudit(state, 'Autorização digital de retirada criada', {
      encomendaId: String(item.id || ''),
      moradorId: String(item.moradorId || ''),
      autorizado: nome,
      documentoFinal: maskDocument(documento)
    }, new Date(now));
    await this.writeState(associationId, state);

    let whatsappEnviado = false;
    try {
      const expiresText = new Date(record.expiraEm).toLocaleString('pt-BR');
      await this.sendText(resident.whats,
        'PortalSync - autorização de retirada criada.\n' +
        'Encomenda: ' + (item.codigo || '-') + '\n' +
        'Pessoa autorizada: ' + nome + '\n' +
        'Documento: ' + maskDocument(documento) + '\n' +
        'Código de autorização: ' + code + '\n' +
        'Válido até: ' + expiresText + '.\n' +
        'Compartilhe o código apenas com a pessoa autorizada.'
      );
      whatsappEnviado = true;
    } catch (_) {}

    return {
      ok: true,
      codigo: code,
      whatsappEnviado,
      autorizacao: authorizationSummary(record, now),
      message: 'Autorização digital criada para esta encomenda.'
    };
  }

  async cancelThirdPartyAuthorization(token, packageId) {
    const session = this.requireSession(token);
    const associationId = session.associationId || this.defaultAssociationId;
    const state = await this.readState(associationId);
    const item = this.ownedPendingPackage(state, session, packageId);
    const now = this.now();
    const record = activeAuthorization(item, now);
    if (!record) throw statusError('Não há autorização ativa para esta encomenda.', 409);
    record.status = 'cancelada';
    record.canceladaEm = new Date(now).toISOString();
    state.version = Date.now();
    state.updatedAt = new Date(now).toISOString();
    appendAudit(state, 'Autorização digital de retirada cancelada', {
      encomendaId: String(item.id || ''),
      moradorId: String(item.moradorId || ''),
      autorizado: record.nome || '',
      documentoFinal: maskDocument(record.documento)
    }, new Date(now));
    await this.writeState(associationId, state);
    return { ok: true, message: 'Autorização cancelada.' };
  }

  async verifyThirdPartyAuthorization(associationId, packageId, input = {}, operator = {}) {
    const scoped = String(associationId || this.defaultAssociationId);
    const state = await this.readState(scoped);
    const item = (state?.encomendas || []).find(pkg => String(pkg?.id || '') === String(packageId || ''));
    if (!item || String(item.status || '') !== 'pendente') throw statusError('Encomenda pendente não encontrada.', 404);
    const now = this.now();
    const record = activeAuthorization(item, now);
    if (!record) {
      const latest = latestAuthorization(item);
      if (latest && authorizationStatus(latest, now) === 'expirada') throw statusError('A autorização digital expirou. O morador deve gerar uma nova.', 410);
      throw statusError('Não há autorização digital ativa para esta encomenda.', 404);
    }
    if (Number(record.tentativasInvalidas || 0) >= this.authorizationMaxAttempts) {
      record.status = 'bloqueada';
      record.bloqueadaEm = record.bloqueadaEm || new Date(now).toISOString();
      await this.writeState(scoped, state);
      throw statusError('Autorização bloqueada por excesso de tentativas. O morador deve gerar uma nova.', 429);
    }

    const documento = normalizeDocument(input.documento || input.document);
    const codigo = digits(input.codigo || input.code).slice(0, 6);
    const documentOk = documento && documento === normalizeDocument(record.documento);
    const hash = authorizationHash(codigo, record.codigoSalt);
    const codeOk = /^\d{6}$/.test(codigo) && safeHashEqual(hash, record.codigoHash);
    if (!documentOk || !codeOk) {
      record.tentativasInvalidas = Number(record.tentativasInvalidas || 0) + 1;
      if (record.tentativasInvalidas >= this.authorizationMaxAttempts) {
        record.status = 'bloqueada';
        record.bloqueadaEm = new Date(now).toISOString();
      }
      state.version = Date.now();
      state.updatedAt = new Date(now).toISOString();
      appendAudit(state, 'Tentativa inválida de autorização digital', {
        usuario: String(operator.nome || operator.id || 'Portaria'),
        encomendaId: String(item.id || ''),
        autorizado: record.nome || '',
        documentoFinal: maskDocument(documento || record.documento)
      }, new Date(now));
      await this.writeState(scoped, state);
      if (record.status === 'bloqueada') throw statusError('Autorização bloqueada por excesso de tentativas. O morador deve gerar uma nova.', 429);
      throw statusError('Código ou documento da autorização não confere.', 401);
    }

    record.validadaEm = new Date(now).toISOString();
    record.validadaPor = String(operator.nome || operator.id || 'Portaria');
    record.tentativasInvalidas = 0;
    state.version = Date.now();
    state.updatedAt = new Date(now).toISOString();
    appendAudit(state, 'Autorização digital de retirada validada', {
      usuario: record.validadaPor,
      encomendaId: String(item.id || ''),
      moradorId: String(item.moradorId || ''),
      autorizado: record.nome || '',
      documentoFinal: maskDocument(record.documento)
    }, new Date(now));
    await this.writeState(scoped, state);
    return {
      ok: true,
      authorizationId: String(record.id || ''),
      nome: String(record.nome || ''),
      documentoMascarado: maskDocument(record.documento),
      validadaEm: record.validadaEm,
      expiraEm: record.expiraEm || null
    };
  }

  async resendPin(token, packageId) {
    const session = this.requireSession(token);
    const associationId = session.associationId || this.defaultAssociationId;
    const state = await this.readState(associationId);
    const item = (state?.encomendas || []).find(pkg => String(pkg?.id || '') === String(packageId || ''));
    if (!item || !session.residentIds.includes(String(item.moradorId || ''))) throw statusError('Encomenda não encontrada.', 404);
    if (item.status !== 'pendente') throw statusError('Esta encomenda não está mais pendente.', 409);
    const resident = (state?.moradores || []).find(m => String(m?.id || '') === String(item.moradorId || ''));
    if (!resident || !phonesMatch(resident.whats, session.phone)) throw statusError('Contato do morador não confere com a sessão.', 403);

    let pin = String(item.pinRetirada || '').replace(/\D/g, '').slice(0, 6);
    if (pin.length !== 6) {
      pin = this.codeGenerator();
      item.pinRetirada = pin;
      item.pinRetiradaGeradoEm = new Date(this.now()).toISOString();
    }

    const message =
      'Olá ' + (resident.nome || 'morador') + '! 📦 Sua encomenda continua aguardando retirada na portaria.\n' +
      '🔖 Código: ' + (item.codigo || '-') + '\n' +
      '🔐 PIN de retirada: ' + pin + '\n' +
      'Apresente este PIN na portaria no momento da retirada.';

    await this.sendText(resident.whats, message);
    item.pinRetiradaEnviado = true;
    item.pinRetiradaEnviadoEm = new Date(this.now()).toISOString();
    delete item.pinRetiradaFalhaEnvioEm;
    state.version = Date.now();
    state.updatedAt = new Date(this.now()).toISOString();
    await this.writeState(associationId, state);
    return { ok: true, message: 'PIN reenviado para o WhatsApp cadastrado.' };
  }

  logout(token) {
    this.sessions.delete(String(token || ''));
    return { ok: true };
  }
}

module.exports = {
  ResidentPortalService,
  digits,
  normalizeLocalPhone,
  phoneVariants,
  phonesMatch,
  maskPhone,
  normalizeDocument,
  maskDocument,
  authorizationStatus,
  latestAuthorization,
  activeAuthorization,
  authorizationSummary,
  cleanPackage,
  finalizePackageAuthorizations
};
