'use strict';

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.startsWith('55') ? digits : '55' + digits;
}

function cleanText(value, fallback = '-') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

class WhatsAppProvider {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.fetch = options.fetchFn || globalThis.fetch;
    this.provider = this.resolveProvider();
  }

  resolveProvider() {
    const explicit = String(this.env.WHATSAPP_PROVIDER || '').trim().toLowerCase();
    if (explicit) return explicit;
    if (this.env.META_WHATSAPP_ACCESS_TOKEN && this.env.META_WHATSAPP_PHONE_NUMBER_ID) return 'meta';
    if (this.env.ZAPI_URL && this.env.ZAPI_CLIENT) return 'zapi';
    return 'none';
  }

  metaConfig() {
    return {
      accessToken: String(this.env.META_WHATSAPP_ACCESS_TOKEN || '').trim(),
      phoneNumberId: String(this.env.META_WHATSAPP_PHONE_NUMBER_ID || '').trim(),
      wabaId: String(this.env.META_WHATSAPP_WABA_ID || '').trim(),
      graphVersion: String(this.env.META_GRAPH_API_VERSION || '').trim(),
      packageTemplate: String(this.env.META_WHATSAPP_TEMPLATE_PACKAGE || 'aviso_encomenda_portaria').trim(),
      reminderTemplate: String(this.env.META_WHATSAPP_TEMPLATE_REMINDER || 'lembrete_encomenda_portaria').trim(),
      language: String(this.env.META_WHATSAPP_TEMPLATE_LANGUAGE || 'pt_BR').trim()
    };
  }

  zapiConfig() {
    return {
      url: String(this.env.ZAPI_URL || '').trim().replace(/\/$/, ''),
      client: String(this.env.ZAPI_CLIENT || '').trim()
    };
  }

  configured() {
    if (this.provider === 'meta') {
      const cfg = this.metaConfig();
      return !!(cfg.accessToken && cfg.phoneNumberId && cfg.graphVersion && cfg.packageTemplate && cfg.reminderTemplate);
    }
    if (this.provider === 'zapi') {
      const cfg = this.zapiConfig();
      return !!(cfg.url && cfg.client);
    }
    return false;
  }

  status() {
    const result = {
      provider: this.provider,
      configured: this.configured(),
      mode: this.provider === 'meta' ? 'official-cloud-api' : this.provider === 'zapi' ? 'legacy-zapi' : 'disabled'
    };
    if (this.provider === 'meta') {
      const cfg = this.metaConfig();
      result.meta = {
        phoneNumberId: !!cfg.phoneNumberId,
        wabaId: !!cfg.wabaId,
        graphVersion: cfg.graphVersion || null,
        packageTemplate: cfg.packageTemplate || null,
        reminderTemplate: cfg.reminderTemplate || null,
        language: cfg.language || null,
        accessTokenConfigured: !!cfg.accessToken
      };
    }
    return result;
  }

  requireConfigured() {
    if (this.configured()) return;
    const err = new Error(this.provider === 'meta'
      ? 'WhatsApp Meta Cloud API não está completamente configurado no .env.'
      : this.provider === 'zapi'
        ? 'WhatsApp/Z-API não está completamente configurado no .env.'
        : 'WhatsApp não está configurado.');
    err.statusCode = 503;
    throw err;
  }

  async metaRequest(body) {
    this.requireConfigured();
    const cfg = this.metaConfig();
    const response = await this.fetch(`https://graph.facebook.com/${encodeURIComponent(cfg.graphVersion)}/${encodeURIComponent(cfg.phoneNumberId)}/messages`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + cfg.accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    let payload = null;
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) {
      const detail = payload?.error?.message || `Meta WhatsApp respondeu ${response.status}`;
      const err = new Error(detail);
      err.statusCode = 502;
      err.remoteStatus = response.status;
      throw err;
    }
    return { ok: true, status: response.status, provider: 'meta', response: payload };
  }

  async sendTemplate(numero, templateName, parameters) {
    if (this.provider !== 'meta') throw new Error('sendTemplate é exclusivo da Meta Cloud API.');
    const cfg = this.metaConfig();
    const to = normalizePhone(numero);
    if (!to) {
      const err = new Error('Número de WhatsApp inválido.');
      err.statusCode = 400;
      throw err;
    }
    return this.metaRequest({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: cfg.language },
        components: [{
          type: 'body',
          parameters: (parameters || []).map(value => ({ type: 'text', text: cleanText(value) }))
        }]
      }
    });
  }

  async zapiText(numero, mensagem) {
    this.requireConfigured();
    const cfg = this.zapiConfig();
    const phone = normalizePhone(numero);
    const response = await this.fetch(`${cfg.url}/send-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Client-Token': cfg.client },
      body: JSON.stringify({ phone, message: cleanText(mensagem, '') })
    });
    if (!response.ok) {
      const err = new Error(`Z-API respondeu ${response.status}`);
      err.statusCode = 502;
      throw err;
    }
    return { ok: true, status: response.status, provider: 'zapi' };
  }

  async sendPackage(data = {}) {
    this.requireConfigured();
    if (this.provider === 'meta') {
      const cfg = this.metaConfig();
      return this.sendTemplate(data.numero, cfg.packageTemplate, [
        data.nome,
        data.codigo,
        data.transportadora,
        data.casa
      ]);
    }
    const message = data.mensagem || `Olá ${cleanText(data.nome)}! 📦 Chegou uma encomenda na portaria.\n🏠 ${cleanText(data.casa)}\n🚚 ${cleanText(data.transportadora)}\n🔖 Código: ${cleanText(data.codigo)}`;
    return this.zapiText(data.numero, message);
  }

  async sendReminder(data = {}) {
    this.requireConfigured();
    if (this.provider === 'meta') {
      const cfg = this.metaConfig();
      return this.sendTemplate(data.numero, cfg.reminderTemplate, [
        data.nome,
        data.codigo,
        data.transportadora,
        data.dias,
        data.casa
      ]);
    }
    const message = data.mensagem || `Olá ${cleanText(data.nome)}! 📦 Lembrete da portaria: sua encomenda ${cleanText(data.codigo)} (${cleanText(data.transportadora)}) está aguardando retirada há ${cleanText(data.dias, '0')} dia(s).\n🏠 ${cleanText(data.casa)}\nPor favor, retire assim que possível.`;
    return this.zapiText(data.numero, message);
  }

  async sendTest(numero) {
    this.requireConfigured();
    if (this.provider === 'meta') {
      const cfg = this.metaConfig();
      return this.sendTemplate(numero, cfg.packageTemplate, [
        'Teste PortariaSync',
        'TESTE',
        'PortariaSync',
        'Teste de configuração'
      ]);
    }
    return this.zapiText(numero, '✅ PortariaSync - WhatsApp conectado e funcionando!');
  }

  async sendText(numero, mensagem) {
    this.requireConfigured();
    if (this.provider === 'meta') {
      const to = normalizePhone(numero);
      if (!to) {
        const err = new Error('Número de WhatsApp inválido.');
        err.statusCode = 400;
        throw err;
      }
      return this.metaRequest({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { preview_url: false, body: cleanText(mensagem, '') }
      });
    }
    return this.zapiText(numero, mensagem);
  }

  async sendImage(numero, imagemBase64, caption) {
    this.requireConfigured();
    if (this.provider === 'meta') {
      const err = new Error('Envio de imagem ainda não está habilitado no provedor Meta. Use os avisos por template.');
      err.statusCode = 409;
      throw err;
    }
    const cfg = this.zapiConfig();
    const phone = normalizePhone(numero);
    const base64 = String(imagemBase64 || '').replace(/^data:image\/\w+;base64,/, '');
    const response = await this.fetch(`${cfg.url}/send-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Client-Token': cfg.client },
      body: JSON.stringify({ phone, image: 'data:image/jpeg;base64,' + base64, caption: cleanText(caption, '') })
    });
    if (!response.ok) {
      const err = new Error(`Z-API respondeu ${response.status}`);
      err.statusCode = 502;
      throw err;
    }
    return { ok: true, status: response.status, provider: 'zapi' };
  }
}

module.exports = { WhatsAppProvider, normalizePhone };
