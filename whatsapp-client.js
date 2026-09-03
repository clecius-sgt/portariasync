(function(root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.PortariaSyncWhatsApp = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const VERSION = '2026-09-03.2';
  const PIN_LENGTH = 6;

  function normalizePin(value) {
    return String(value || '').replace(/\D/g, '').slice(0, PIN_LENGTH);
  }

  function generatePin(host) {
    try {
      if (host?.crypto && typeof host.crypto.getRandomValues === 'function') {
        const data = new Uint32Array(1);
        host.crypto.getRandomValues(data);
        return String(100000 + (data[0] % 900000));
      }
    } catch (_) {}
    return String(100000 + Math.floor(Math.random() * 900000));
  }

  function ensurePin(host, enc) {
    if (!enc || typeof enc !== 'object') return '';
    if (host?.WithdrawalPin && typeof host.WithdrawalPin.ensurePin === 'function') {
      return host.WithdrawalPin.ensurePin(enc, host);
    }
    const existing = normalizePin(enc.pinRetirada);
    if (existing.length === PIN_LENGTH) {
      enc.pinRetirada = existing;
      return existing;
    }
    const pin = generatePin(host);
    enc.pinRetirada = pin;
    enc.pinRetiradaGeradoEm = new Date().toISOString();
    enc.pinRetiradaEnviado = false;
    return pin;
  }

  function appendPin(message, pin) {
    const cleanPin = normalizePin(pin);
    const base = String(message || '').trim();
    if (cleanPin.length !== PIN_LENGTH) return base;
    if (base.includes(cleanPin) || /PIN\s+de\s+retirada/i.test(base)) return base;
    return base + '\n🔐 PIN de retirada: ' + cleanPin + '\nApresente este PIN na portaria no momento da retirada.';
  }

  function persist(host) {
    try {
      if (typeof host?.salvarEncomendas === 'function') host.salvarEncomendas();
    } catch (_) {}
  }

  function packageMessage(host, morador, enc) {
    const config = host.config || {};
    const base = String(config.mensagem || 'Olá {nome}! 📦 Chegou uma encomenda na portaria.\n🏠 {casa}\n🚚 {transportadora}\n🔖 Código: {codigo}')
      .replace('{nome}', morador?.nome || '')
      .replace('{casa}', morador?.casa || '')
      .replace('{transportadora}', enc?.transportadora || '')
      .replace('{codigo}', enc?.codigo || '')
      .replace('{pin}', enc?.pinRetirada || '');
    return appendPin(base, enc?.pinRetirada);
  }

  async function post(host, path, body) {
    if (!host || typeof host.apiFetch !== 'function') throw new Error('API do PortariaSync indisponível.');
    const response = await host.apiFetch(path, {
      method: 'POST',
      body: JSON.stringify(body || {})
    });
    if (!response?.ok) throw new Error('Falha no envio pelo WhatsApp.');
    return response;
  }

  async function sendPackage(host, morador, enc) {
    const pin = ensurePin(host, enc);
    persist(host);
    try {
      await post(host, '/api/whatsapp/package', {
        numero: morador?.whats,
        nome: morador?.nome,
        casa: morador?.casa,
        transportadora: enc?.transportadora,
        codigo: enc?.codigo,
        pin,
        mensagem: packageMessage(host, morador, enc)
      });
      if (enc) {
        enc.pinRetiradaEnviado = true;
        enc.pinRetiradaEnviadoEm = new Date().toISOString();
        delete enc.pinRetiradaFalhaEnvioEm;
        persist(host);
      }
      host.toast?.('📲 WhatsApp enviado para ' + (morador?.nome || 'morador') + '!');
      return true;
    } catch (error) {
      if (enc) {
        enc.pinRetiradaEnviado = false;
        enc.pinRetiradaFalhaEnvioEm = new Date().toISOString();
        persist(host);
      }
      host.console?.error?.('WhatsApp: falha no aviso de encomenda:', error);
      host.toast?.('⚠️ Encomenda registrada, mas falha no WhatsApp. O PIN não será exigido até o aviso ser enviado.', 6000);
      return false;
    }
  }

  async function sendReminder(host, morador, enc) {
    const dias = typeof host.diasAguardandoRetirada === 'function' ? host.diasAguardandoRetirada(enc) : 0;
    const pin = ensurePin(host, enc);
    persist(host);
    const base = `Olá ${morador?.nome || ''}! 📦 Lembrete da portaria: sua encomenda ${enc?.codigo || ''} (${enc?.transportadora || ''}) está aguardando retirada há ${dias} dia(s).\n🏠 ${morador?.casa || ''}\nPor favor, retire assim que possível.`;
    const mensagem = appendPin(base, pin);
    try {
      await post(host, '/api/whatsapp/reminder', {
        numero: morador?.whats,
        nome: morador?.nome,
        casa: morador?.casa,
        transportadora: enc?.transportadora,
        codigo: enc?.codigo,
        dias,
        pin,
        mensagem
      });
      if (enc) {
        enc.pinRetiradaEnviado = true;
        enc.pinRetiradaEnviadoEm = enc.pinRetiradaEnviadoEm || new Date().toISOString();
        delete enc.pinRetiradaFalhaEnvioEm;
        persist(host);
      }
      return true;
    } catch (error) {
      host.console?.error?.('WhatsApp: falha no lembrete de retirada:', error);
      return false;
    }
  }

  async function testConnection(host) {
    if (typeof host.exigirPerfil === 'function' && !host.exigirPerfil(['admin'])) return false;
    const numero = host.prompt?.('Digite seu número para teste (com DDD, sem +55):');
    if (!numero) return false;
    try {
      await post(host, '/api/whatsapp/test', { numero: String(numero).replace(/\D/g, '') });
      host.toast?.('✅ Mensagem de teste enviada!');
      return true;
    } catch (error) {
      host.console?.error?.('WhatsApp: teste falhou:', error);
      host.toast?.('❌ Falha no envio. Verifique o provedor no painel administrativo.');
      return false;
    }
  }

  function install(host) {
    host = host || root;
    if (!host || host.__portariaWhatsAppInstalled) return !!host;
    if (typeof host.apiFetch !== 'function') return false;
    host.__portariaWhatsAppInstalled = true;

    host.enviarWhatsApp = function(morador, enc) {
      return sendPackage(host, morador, enc);
    };
    host.enviarLembreteRetirada = function(morador, enc) {
      return sendReminder(host, morador, enc);
    };
    host.testarWhatsApp = function() {
      return testConnection(host);
    };

    host.PortariaSyncWhatsAppRuntime = {
      version: VERSION,
      sendPackage: (morador, enc) => sendPackage(host, morador, enc),
      sendReminder: (morador, enc) => sendReminder(host, morador, enc),
      test: () => testConnection(host)
    };
    return true;
  }

  return {
    VERSION,
    PIN_LENGTH,
    normalizePin,
    generatePin,
    ensurePin,
    appendPin,
    packageMessage,
    post,
    sendPackage,
    sendReminder,
    testConnection,
    install,
    version: VERSION
  };
});