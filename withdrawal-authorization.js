(function(root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WithdrawalAuthorization = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';

  const VERSION = '2026-09-03.1';

  function normalizeDocument(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 30);
  }

  function normalizeName(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function records(pkg) {
    const list = Array.isArray(pkg?.autorizacoesRetirada) ? pkg.autorizacoesRetirada.filter(Boolean) : [];
    if (!list.length && pkg?.autorizacaoRetirada && typeof pkg.autorizacaoRetirada === 'object') list.push(pkg.autorizacaoRetirada);
    return list;
  }

  function status(record, now = Date.now()) {
    if (!record) return 'inexistente';
    const explicit = String(record.status || 'ativa').toLowerCase();
    if (explicit !== 'ativa') return explicit;
    const expires = Date.parse(record.expiraEm || '');
    if (Number.isFinite(expires) && expires <= Number(now)) return 'expirada';
    return 'ativa';
  }

  function latestAuthorization(pkg) {
    return records(pkg).slice().sort((a, b) => Date.parse(b.criadaEm || 0) - Date.parse(a.criadaEm || 0))[0] || null;
  }

  function activeAuthorization(pkg, now = Date.now()) {
    return records(pkg)
      .filter(record => status(record, now) === 'ativa')
      .sort((a, b) => Date.parse(b.criadaEm || 0) - Date.parse(a.criadaEm || 0))[0] || null;
  }

  function formatDate(value) {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('pt-BR');
  }

  function currentPackages() {
    try {
      if (typeof encomendas !== 'undefined' && Array.isArray(encomendas)) return encomendas;
    } catch (_) {}
    return Array.isArray(root?.encomendas) ? root.encomendas : [];
  }

  function findPackage(id) {
    return currentPackages().find(item => String(item?.id || '') === String(id || '')) || null;
  }

  function notify(message, duration) {
    if (typeof root?.toast === 'function') root.toast(message, duration);
    else root?.alert?.(message);
  }

  async function api(path, body) {
    const token = root?.localStorage?.getItem('authToken') || '';
    if (!token) throw new Error('Sessão da portaria não encontrada.');
    const response = await root.fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token
      },
      body: JSON.stringify(body || {})
    });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) {
      const error = new Error(data.error || data.detail || 'Não foi possível validar a autorização.');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function renderAuthorization(id) {
    const modal = root?.document?.getElementById('modalRetirada');
    const pkg = findPackage(id);
    if (!modal || !pkg) return false;
    const latest = latestAuthorization(pkg);
    if (!latest) return false;

    const previous = root.document.getElementById('digitalWithdrawalAuthorization');
    if (previous) previous.remove();
    const currentStatus = status(latest);
    const box = root.document.createElement('div');
    box.id = 'digitalWithdrawalAuthorization';
    const active = currentStatus === 'ativa';
    box.style.cssText = active
      ? 'margin:0 0 16px;padding:12px;border:1px solid #9ad0ad;border-radius:10px;background:#eef9f1;color:#174f2b;font-size:13px;line-height:1.5;'
      : 'margin:0 0 16px;padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;color:#64748b;font-size:13px;line-height:1.5;';
    const masked = '***' + normalizeDocument(latest.documento).slice(-4);
    box.innerHTML = active
      ? '<strong>Autorização digital ativa</strong><br>Pessoa: ' + escapeHtml(latest.nome || '-') +
        '<br>Documento: ' + escapeHtml(masked) + '<br>Válida até: ' + escapeHtml(formatDate(latest.expiraEm)) +
        '<br><small>O código de autorização será solicitado ao confirmar a retirada.</small>'
      : '<strong>Autorização digital ' + escapeHtml(currentStatus) + '</strong><br>Pessoa: ' + escapeHtml(latest.nome || '-') +
        '<br>Documento: ' + escapeHtml(masked) + '<br>Validade: ' + escapeHtml(formatDate(latest.expiraEm));

    const card = modal.firstElementChild;
    if (card) {
      if (card.children[1]) card.children[1].insertAdjacentElement('afterend', box);
      else card.insertBefore(box, card.firstChild);
    }

    if (active) {
      try { root.selecionarRetirante?.('outro', ''); } catch (_) {}
      root._retiranteTipo = 'outro';
      root._retirante = String(latest.nome || '');
      root._retiranteRg = String(latest.documento || '');
      const nameInput = root.document.getElementById('inputRetirante');
      const docInput = root.document.getElementById('inputRetiranteRg');
      const nameLabel = root.document.getElementById('nomeRetirante');
      if (nameInput) nameInput.value = root._retirante;
      if (docInput) docInput.value = root._retiranteRg;
      if (nameLabel) nameLabel.textContent = 'Autorizado digitalmente: ' + root._retirante;
    }
    return true;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  async function validateBeforeWithdrawal(id, original, args) {
    const pkg = findPackage(id);
    if (!pkg || root._retiranteTipo !== 'outro') return original.apply(root, args);
    const authorization = activeAuthorization(pkg);
    if (!authorization) return original.apply(root, args);

    const name = String(root._retirante || '').trim();
    const document = String(root._retiranteRg || '').trim();
    if (normalizeName(name) !== normalizeName(authorization.nome) || normalizeDocument(document) !== normalizeDocument(authorization.documento)) {
      notify('Os dados informados não correspondem à autorização digital ativa desta encomenda.', 6500);
      return false;
    }

    const alreadyValidated = root._autorizacaoDigitalValidada;
    if (!alreadyValidated || String(alreadyValidated.authorizationId || '') !== String(authorization.id || '')) {
      const code = String(root.prompt?.('Informe o código de 6 dígitos da autorização digital:') || '').replace(/\D/g, '').slice(0, 6);
      if (!code) return false;
      if (!/^\d{6}$/.test(code)) {
        notify('O código da autorização deve possuir 6 dígitos.', 5000);
        return false;
      }
      try {
        const result = await api('/api/withdrawal-authorization/verify', {
          packageId: id,
          codigo: code,
          documento: document
        });
        root._autorizacaoDigitalValidada = result;
        authorization.validadaEm = result.validadaEm || new Date().toISOString();
        authorization.validadaPor = result.validadaPor || 'Portaria';
        notify('Autorização digital validada. Complete a assinatura e a foto do retirante.', 5000);
      } catch (error) {
        notify(error.message, 6500);
        return false;
      }
    }
    return original.apply(root, args);
  }

  function install(host) {
    root = host || root;
    if (!root?.document || root.__withdrawalAuthorizationInstalled) return false;
    if (typeof root.abrirModalRetirada !== 'function' || typeof root.confirmarRetirada !== 'function') {
      root.setTimeout?.(() => install(root), 250);
      return false;
    }
    root.__withdrawalAuthorizationInstalled = true;

    const originalOpen = root.abrirModalRetirada;
    root.abrirModalRetirada = function(enc) {
      root._autorizacaoDigitalValidada = null;
      const result = originalOpen.apply(this, arguments);
      root.setTimeout?.(() => renderAuthorization(enc?.id), 0);
      return result;
    };

    const originalConfirm = root.confirmarRetirada;
    root.confirmarRetirada = function(id) {
      return validateBeforeWithdrawal(id, originalConfirm, arguments);
    };
    return true;
  }

  const apiObject = {
    VERSION,
    normalizeDocument,
    normalizeName,
    status,
    latestAuthorization,
    activeAuthorization,
    install,
    version: VERSION
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => install(root), { once: true });
    else install(root);
  }

  return apiObject;
});
