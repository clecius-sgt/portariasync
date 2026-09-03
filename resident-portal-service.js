'use strict';

const crypto = require('crypto');

function digits(value) {
  return String(value || '').replace(/\D/g, '');
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

function cleanPackage(item) {
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
    pinAtivo: /^\d{6}$/.test(String(item?.pinRetirada || '')) && item?.pinRetiradaEnviado === true
  };
}

function statusError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
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
    this.otpTtlMs = Number(options.otpTtlMs || 10 * 60 * 1000);
    this.sessionTtlMs = Number(options.sessionTtlMs || 12 * 60 * 60 * 1000);
    this.cooldownMs = Number(options.cooldownMs || 60 * 1000);
    this.maxAttempts = Number(options.maxAttempts || 5);
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
      otpTtlMinutes: Math.round(this.otpTtlMs / 60000),
      sessionHours: Math.round(this.sessionTtlMs / 3600000),
      activeSessions: this.sessions.size
    };
  }

  async requestCode(phone, ip = '', associationId = this.defaultAssociationId) {
    this.cleanup();
    const informed = digits(phone);
    if (informed.length < 10 || informed.length > 15) throw statusError('Informe um número de WhatsApp válido.', 400);
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
    const packages = (state?.encomendas || [])
      .filter(item => session.residentIds.includes(String(item?.moradorId || '')))
      .map(cleanPackage);
    return { ok: true, associationId: session.associationId || this.defaultAssociationId, packages };
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
  phoneVariants,
  phonesMatch,
  maskPhone,
  cleanPackage
};
