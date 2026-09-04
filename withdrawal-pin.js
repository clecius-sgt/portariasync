(function(root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.WithdrawalPin = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const VERSION = '2026-09-03.2';
  const PIN_LENGTH = 6;

  function normalizePin(value) {
    return String(value || '').replace(/\D/g, '').slice(0, PIN_LENGTH);
  }

  function normalizeDocument(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 30);
  }

  function generatePin(host) {
    host = host || root;
    try {
      if (host?.crypto && typeof host.crypto.getRandomValues === 'function') {
        const data = new Uint32Array(1);
        host.crypto.getRandomValues(data);
        return String(100000 + (data[0] % 900000));
      }
    } catch (_) {}
    return String(100000 + Math.floor(Math.random() * 900000));
  }

  function ensurePin(enc, host) {
    if (!enc || typeof enc !== 'object') return '';
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

  function pinRequired(enc) {
    return !!(
      enc &&
      enc.status === 'pendente' &&
      normalizePin(enc.pinRetirada).length === PIN_LENGTH &&
      enc.pinRetiradaEnviado === true
    );
  }

  function validatePin(enc, value) {
    if (!pinRequired(enc)) return true;
    const expected = normalizePin(enc.pinRetirada);
    const informed = normalizePin(value);
    return informed.length === PIN_LENGTH && informed === expected;
  }

  function activeDigitalAuthorization(enc, now = Date.now()) {
    const list = Array.isArray(enc?.autorizacoesRetirada) ? enc.autorizacoesRetirada.filter(Boolean) : [];
    if (!list.length && enc?.autorizacaoRetirada && typeof enc.autorizacaoRetirada === 'object') list.push(enc.autorizacaoRetirada);
    return list
      .filter(record => {
        if (String(record?.status || 'ativa').toLowerCase() !== 'ativa') return false;
        const expires = Date.parse(record?.expiraEm || '');
        return !Number.isFinite(expires) || expires > Number(now);
      })
      .sort((a, b) => Date.parse(b.criadaEm || 0) - Date.parse(a.criadaEm || 0))[0] || null;
  }

  function digitalAuthorizationApplies(enc, host, now = Date.now()) {
    if (!enc || host?._retiranteTipo !== 'outro') return false;
    if (host?.__withdrawalAuthorizationInstalled !== true) return false;
    const authorization = activeDigitalAuthorization(enc, now);
    if (!authorization) return false;
    const document = normalizeDocument(host?._retiranteRg || '');
    return !!document && document === normalizeDocument(authorization.documento);
  }

  function appendPinMessage(message, pin) {
    const cleanPin = normalizePin(pin);
    const base = String(message || '').trim();
    if (cleanPin.length !== PIN_LENGTH) return base;
    if (base.includes(cleanPin) || /PIN\s+de\s+retirada/i.test(base)) return base;
    return base + '\n🔐 PIN de retirada: ' + cleanPin + '\nApresente este PIN na portaria no momento da retirada.';
  }

  function persist(host) {
    try {
      if (host && typeof host.salvarEncomendas === 'function') host.salvarEncomendas();
    } catch (_) {}
  }

  function audit(host, action, detail) {
    try {
      if (host && typeof host.registrarAuditoria === 'function') host.registrarAuditoria(action, detail || {});
    } catch (_) {}
  }

  function injectPinUi(host, enc) {
    const doc = host?.document;
    if (!doc || !enc) return false;
    const modal = doc.getElementById('modalRetirada');
    if (!modal || modal.querySelector?.('#areaPinRetirada')) return !!modal;
    modal._pinEncomenda = enc;
    modal._pinOverride = null;
    modal._pinAttempts = 0;

    const firstLabel = modal.querySelector?.('label');
    if (!firstLabel || !firstLabel.parentNode || typeof doc.createElement !== 'function') return false;

    const required = pinRequired(enc);
    const hasDigitalAuthorization = !!activeDigitalAuthorization(enc);
    const section = doc.createElement('div');
    section.id = 'areaPinRetirada';
    section.style.cssText = 'margin:0 0 16px;padding:13px;border:1px solid ' + (required ? '#b7c6d8' : '#dadce0') + ';border-radius:10px;background:' + (required ? '#f8fbff' : '#f8f9fa') + ';';

    if (required) {
      section.innerHTML =
        '<div style="font-size:14px;font-weight:800;color:#1a1f3a;margin-bottom:4px;">🔐 PIN de retirada</div>' +
        '<div style="font-size:12px;color:#5f6368;line-height:1.45;margin-bottom:8px;">' +
          (hasDigitalAuthorization
            ? 'Para o próprio morador, solicite o PIN de 6 dígitos. Para o terceiro autorizado digitalmente, o código da autorização substitui este PIN; RG/foto e assinatura continuam obrigatórios.'
            : 'Solicite o PIN de 6 dígitos enviado ao WhatsApp do morador. O PIN é adicional à assinatura e não substitui RG/foto quando a retirada for feita por terceiro.') +
        '</div>' +
        '<input id="inputPinRetirada" type="password" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" aria-label="PIN de retirada" ' +
          'style="width:100%;padding:12px;text-align:center;letter-spacing:7px;font-size:21px;font-weight:800;border:1px solid #b7c6d8;border-radius:8px;background:white;">' +
        '<div id="statusPinRetirada" style="font-size:12px;color:#5f6368;margin-top:6px;">Obrigatório para o próprio morador.</div>';

      const input = section.querySelector('#inputPinRetirada');
      if (input) {
        input.addEventListener('input', function() {
          this.value = normalizePin(this.value);
          const status = section.querySelector('#statusPinRetirada');
          if (status) {
            status.textContent = this.value.length === PIN_LENGTH ? 'PIN preenchido. Confirme a retirada para validar.' : 'Obrigatório para o próprio morador.';
            status.style.color = '#5f6368';
          }
        });
      }

      const isAdmin = typeof host.temPerfil === 'function' && host.temPerfil(['admin']);
      if (isAdmin) {
        const override = doc.createElement('button');
        override.type = 'button';
        override.id = 'btnLiberarSemPin';
        override.textContent = 'Administrador: liberar sem PIN';
        override.style.cssText = 'margin-top:9px;border:0;background:none;color:#b45309;font-size:12px;font-weight:700;cursor:pointer;padding:0;';
        override.addEventListener('click', function() {
          const reason = String(host.prompt?.('Informe o motivo da liberação sem PIN:') || '').trim();
          if (reason.length < 5) {
            host.toast?.('⚠️ Informe um motivo para a liberação sem PIN.', 5000);
            return;
          }
          modal._pinOverride = { reason, at: new Date().toISOString() };
          if (input) input.disabled = true;
          const status = section.querySelector('#statusPinRetirada');
          if (status) {
            status.textContent = 'Liberação administrativa registrada. A retirada ainda exige os demais controles.';
            status.style.color = '#b45309';
          }
          override.disabled = true;
          override.textContent = 'Liberação sem PIN autorizada';
        });
        section.appendChild(override);
      }
    } else {
      const reason = enc.pinRetirada && enc.pinRetiradaEnviado === false
        ? 'O aviso com PIN não foi confirmado pelo WhatsApp. Use os controles normais de identificação e assinatura.'
        : 'Esta encomenda não possui PIN ativo, normalmente por ter sido cadastrada antes deste recurso.';
      section.innerHTML =
        '<div style="font-size:13px;font-weight:700;color:#5f6368;margin-bottom:3px;">🔐 PIN não exigido</div>' +
        '<div style="font-size:12px;color:#6b7280;line-height:1.45;">' + reason + '</div>';
    }

    firstLabel.parentNode.insertBefore(section, firstLabel);
    return true;
  }

  function install(host) {
    host = host || root;
    if (!host || host.__withdrawalPinInstalled) return !!host;
    if (typeof host.abrirModalRetirada !== 'function' || typeof host.confirmarRetirada !== 'function') return false;
    host.__withdrawalPinInstalled = true;

    const originalOpen = host.abrirModalRetirada;
    host.abrirModalRetirada = function(enc) {
      const result = originalOpen.apply(this, arguments);
      injectPinUi(host, enc);
      return result;
    };

    const originalConfirm = host.confirmarRetirada;
    host.confirmarRetirada = function(id) {
      const modal = host.document?.getElementById?.('modalRetirada');
      const enc = modal?._pinEncomenda || null;
      const override = modal?._pinOverride || null;
      const digitalAuthorization = digitalAuthorizationApplies(enc, host);

      if (enc && pinRequired(enc) && !override && !digitalAuthorization) {
        const input = host.document?.getElementById?.('inputPinRetirada');
        const informed = normalizePin(input?.value || '');
        if (!validatePin(enc, informed)) {
          if (modal) modal._pinAttempts = Number(modal._pinAttempts || 0) + 1;
          const status = host.document?.getElementById?.('statusPinRetirada');
          if (status) {
            status.textContent = 'PIN incorreto. Confira os 6 dígitos enviados ao morador.';
            status.style.color = '#c0392b';
          }
          if (input) {
            input.value = '';
            input.focus?.();
          }
          host.toast?.('⚠️ PIN de retirada incorreto.', 5000);
          return false;
        }
      }

      if (override) {
        const stillAdmin = typeof host.temPerfil === 'function' && host.temPerfil(['admin']);
        if (!stillAdmin) {
          host.toast?.('⚠️ Somente administrador pode liberar retirada sem PIN.', 5000);
          return false;
        }
      }

      const result = originalConfirm.apply(this, arguments);

      if (enc && enc.status === 'retirado' && (pinRequired({ ...enc, status: 'pendente' }) || override || digitalAuthorization)) {
        enc.pinRetiradaValidadoEm = new Date().toISOString();
        enc.pinRetiradaMetodo = digitalAuthorization ? 'autorizacao-digital' : (override ? 'liberacao-administrativa' : 'pin');
        enc.pinRetiradaOverrideMotivo = override?.reason || null;
        enc.pinRetiradaUsado = !override && !digitalAuthorization;
        delete enc.pinRetirada;
        persist(host);
        audit(host,
          digitalAuthorization ? 'Retirada validada por autorização digital' : (override ? 'Retirada liberada sem PIN' : 'PIN de retirada validado'),
          {
            encomendaId: enc.id,
            codigo: enc.codigo,
            moradorId: enc.moradorId,
            moradorNome: enc.moradorNome,
            motivo: override?.reason || null
          }
        );
      }
      return result;
    };

    host.WithdrawalPinRuntime = {
      version: VERSION,
      ensure: enc => ensurePin(enc, host),
      required: pinRequired,
      validate: validatePin,
      digitalAuthorization: enc => activeDigitalAuthorization(enc)
    };
    return true;
  }

  const api = {
    VERSION,
    PIN_LENGTH,
    normalizePin,
    normalizeDocument,
    generatePin,
    ensurePin,
    pinRequired,
    validatePin,
    activeDigitalAuthorization,
    digitalAuthorizationApplies,
    appendPinMessage,
    injectPinUi,
    install,
    version: VERSION
  };

  if (typeof document !== 'undefined') {
    const start = () => install(root);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }

  return api;
});