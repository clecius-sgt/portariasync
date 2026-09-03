(function(root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.PortariaSyncWhatsApp = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const VERSION = '2026-09-03.1';

  function packageMessage(host, morador, enc) {
    const config = host.config || {};
    return String(config.mensagem || 'Olá {nome}! 📦 Chegou uma encomenda na portaria.\n🏠 {casa}\n🚚 {transportadora}\n🔖 Código: {codigo}')
      .replace('{nome}', morador?.nome || '')
      .replace('{casa}', morador?.casa || '')
      .replace('{transportadora}', enc?.transportadora || '')
      .replace('{codigo}', enc?.codigo || '');
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
    try {
      await post(host, '/api/whatsapp/package', {
        numero: morador?.whats,
        nome: morador?.nome,
        casa: morador?.casa,
        transportadora: enc?.transportadora,
        codigo: enc?.codigo,
        mensagem: packageMessage(host, morador, enc)
      });
      host.toast?.('📲 WhatsApp enviado para ' + (morador?.nome || 'morador') + '!');
      return true;
    } catch (error) {
      host.console?.error?.('WhatsApp: falha no aviso de encomenda:', error);
      host.toast?.('⚠️ Encomenda registrada, mas falha no WhatsApp. Avise manualmente.');
      return false;
    }
  }

  async function sendReminder(host, morador, enc) {
    const dias = typeof host.diasAguardandoRetirada === 'function' ? host.diasAguardandoRetirada(enc) : 0;
    const mensagem = `Olá ${morador?.nome || ''}! 📦 Lembrete da portaria: sua encomenda ${enc?.codigo || ''} (${enc?.transportadora || ''}) está aguardando retirada há ${dias} dia(s).\n🏠 ${morador?.casa || ''}\nPor favor, retire assim que possível.`;
    try {
      await post(host, '/api/whatsapp/reminder', {
        numero: morador?.whats,
        nome: morador?.nome,
        casa: morador?.casa,
        transportadora: enc?.transportadora,
        codigo: enc?.codigo,
        dias,
        mensagem
      });
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
    packageMessage,
    post,
    sendPackage,
    sendReminder,
    testConnection,
    install,
    version: VERSION
  };
});
