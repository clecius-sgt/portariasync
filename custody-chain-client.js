(function(root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CustodyChainUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';

  const VERSION = '2026-09-04.2';

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function packageList() {
    try {
      if (typeof encomendas !== 'undefined' && Array.isArray(encomendas)) return encomendas;
    } catch (_) {}
    return Array.isArray(root?.encomendas) ? root.encomendas : [];
  }

  function findPackage(id, list = packageList()) {
    return (list || []).find(item => String(item?.id || '') === String(id || '')) || null;
  }

  async function authoritativePackage(id) {
    try {
      if (typeof root?.apiFetch === 'function') {
        const state = await root.apiFetch('/api/app-state');
        const found = findPackage(id, state?.encomendas || []);
        if (found) return found;
      }
    } catch (_) {}
    return findPackage(id);
  }

  function formatDate(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('pt-BR');
  }

  function integrityLabel(pkg) {
    const meta = pkg?.cadeiaCustodiaMeta || {};
    if (meta.integrity === 'ok') return 'Íntegra e encadeada por SHA-256';
    if (Array.isArray(pkg?.cadeiaCustodia) && pkg.cadeiaCustodia.length) return 'Cadeia disponível';
    return 'Cadeia ainda não inicializada';
  }

  function eventHtml(event) {
    const reconstructed = event?.metadata?.reconstructed === true || event?.metadata?.reconstructedHistory === true;
    const source = event?.source ? `<span style="font-size:11px;color:#64748b;">${esc(event.source)}</span>` : '';
    const badge = reconstructed
      ? '<span style="font-size:10px;font-weight:800;padding:3px 6px;border-radius:999px;background:#fff3cd;color:#856404;">RECONSTRUÍDO</span>'
      : '<span style="font-size:10px;font-weight:800;padding:3px 6px;border-radius:999px;background:#e6f4ea;color:#137333;">REGISTRADO</span>';
    return `<div style="position:relative;padding:0 0 18px 28px;">
      <div style="position:absolute;left:5px;top:5px;width:10px;height:10px;border-radius:50%;background:#c9a84c;box-shadow:0 0 0 4px #fff7db;"></div>
      <div style="position:absolute;left:9px;top:17px;bottom:-2px;width:2px;background:#e2e8f0;"></div>
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;">
        <div><strong style="font-size:14px;color:#1a1f3a;">${esc(event?.title || 'Evento')}</strong><div style="margin-top:4px;">${badge} ${source}</div></div>
        <div style="font-size:11px;color:#64748b;text-align:right;min-width:120px;">${esc(formatDate(event?.occurredAt))}</div>
      </div>
      ${event?.description ? `<div style="font-size:13px;color:#475569;line-height:1.45;margin-top:7px;">${esc(event.description)}</div>` : ''}
      <div style="font-size:11px;color:#64748b;margin-top:6px;">Responsável: ${esc(event?.actor || 'PortalSync')}${event?.actorRole ? ' · ' + esc(event.actorRole) : ''}</div>
      <div style="font-size:10px;color:#94a3b8;margin-top:3px;">Evento #${Number(event?.seq || 0)} · hash ${esc(String(event?.hash || '').slice(0, 12))}…</div>
    </div>`;
  }

  function close() {
    const modal = root?.document?.getElementById('custodyChainModal');
    if (modal) modal.remove();
  }

  async function open(id) {
    let pkg = findPackage(id);
    close();
    const doc = root?.document;
    if (!doc?.body) return false;

    const loading = doc.createElement('div');
    loading.id = 'custodyChainModal';
    loading.style.cssText = 'position:fixed;inset:0;background:rgba(15,18,36,.72);z-index:101000;display:flex;align-items:center;justify-content:center;padding:16px;';
    loading.innerHTML = '<div style="background:white;border-radius:14px;padding:22px 28px;color:#1a1f3a;font-weight:700;">Carregando histórico protegido...</div>';
    doc.body.appendChild(loading);

    pkg = await authoritativePackage(id) || pkg;
    close();
    if (!pkg) {
      root?.toast?.('Encomenda não localizada.', 4000);
      return false;
    }

    const chain = Array.isArray(pkg.cadeiaCustodia) ? pkg.cadeiaCustodia : [];
    const meta = pkg.cadeiaCustodiaMeta || {};
    const modal = doc.createElement('div');
    modal.id = 'custodyChainModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,18,36,.72);z-index:101000;display:flex;align-items:center;justify-content:center;padding:16px;';
    modal.innerHTML = `<div style="width:100%;max-width:680px;max-height:92vh;overflow:auto;background:white;border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.35);">
      <div style="padding:18px 20px;border-bottom:1px solid #e2e8f0;position:sticky;top:0;background:white;z-index:2;">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;">
          <div><div style="font-size:18px;font-weight:800;color:#1a1f3a;">Cadeia de Custódia Digital</div>
          <div style="font-size:13px;color:#64748b;margin-top:3px;">${esc(pkg.codigo || 'Código não informado')} · ${esc(pkg.moradorNome || '')}</div></div>
          <button type="button" onclick="CustodyChainUI.close()" style="border:0;background:#f1f5f9;color:#334155;border-radius:8px;padding:8px 11px;font-weight:800;cursor:pointer;">Fechar</button>
        </div>
        <div style="margin-top:10px;padding:9px 11px;border-radius:9px;background:${meta.integrity === 'ok' ? '#e6f4ea' : '#fff8e1'};color:${meta.integrity === 'ok' ? '#137333' : '#7a5600'};font-size:12px;font-weight:700;">
          ${esc(integrityLabel(pkg))}${meta.eventCount ? ' · ' + Number(meta.eventCount) + ' evento(s)' : ''}
        </div>
      </div>
      <div style="padding:20px;">
        ${chain.length ? chain.map(eventHtml).join('') : '<div style="padding:28px;text-align:center;color:#64748b;">A cadeia ainda não foi inicializada para este registro.</div>'}
      </div>
      <div style="padding:0 20px 20px;color:#64748b;font-size:11px;line-height:1.5;">Os eventos são acrescentados em sequência e vinculados por hash. Correções geram novos registros em vez de apagar o histórico anterior.</div>
    </div>`;
    modal.addEventListener('click', event => { if (event.target === modal) close(); });
    doc.body.appendChild(modal);
    return true;
  }

  function buttonHtml(id) {
    const safeId = String(id || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `<button class="btn btn-sm" style="background:#f1f5f9;color:#334155;" onclick="CustodyChainUI.open('${safeId}')">Histórico completo</button>`;
  }

  function loadPackageAlerts(host) {
    host = host || root;
    const doc = host?.document;
    if (!doc || typeof doc.createElement !== 'function') return false;
    if (host.PackageAlertsUI) {
      if (typeof host.PackageAlertsUI.install === 'function') host.PackageAlertsUI.install(host);
      return true;
    }
    if (doc.querySelector?.('script[data-package-alerts="1"]')) return true;
    const script = doc.createElement('script');
    script.src = '/package-alerts-client.js?v=20260904-1';
    script.async = true;
    script.dataset.packageAlerts = '1';
    script.onload = function() {
      if (host.PackageAlertsUI && typeof host.PackageAlertsUI.install === 'function') host.PackageAlertsUI.install(host);
    };
    (doc.head || doc.documentElement).appendChild(script);
    return true;
  }

  function loadWithdrawalReceipt(host) {
    host = host || root;
    const doc = host?.document;
    if (!doc || typeof doc.createElement !== 'function') return false;
    if (host.WithdrawalReceiptUI) {
      if (typeof host.WithdrawalReceiptUI.install === 'function') host.WithdrawalReceiptUI.install(host);
      return true;
    }
    if (doc.querySelector?.('script[data-withdrawal-receipt="1"]')) return true;
    const script = doc.createElement('script');
    script.src = '/withdrawal-receipt-client.js?v=20260904-1';
    script.async = true;
    script.dataset.withdrawalReceipt = '1';
    script.onload = function() {
      if (host.WithdrawalReceiptUI && typeof host.WithdrawalReceiptUI.install === 'function') host.WithdrawalReceiptUI.install(host);
    };
    (doc.head || doc.documentElement).appendChild(script);
    return true;
  }

  function install(host) {
    root = host || root;
    if (!root || root.__custodyChainUiInstalled) return !!root;
    if (typeof root.itemEncomendaHTML !== 'function') {
      root.setTimeout?.(() => install(root), 250);
      return false;
    }
    root.__custodyChainUiInstalled = true;
    const original = root.itemEncomendaHTML;
    root.itemEncomendaHTML = function(item) {
      const html = String(original.apply(this, arguments) || '');
      const button = buttonHtml(item?.id);
      return html.replace(/<\/div>\s*$/, `<div class="actions" style="margin-top:8px;">${button}</div></div>`);
    };
    root.abrirCadeiaCustodia = open;
    try { root.renderDashboard?.(); } catch (_) {}
    try { root.renderEncomendas?.(); } catch (_) {}
    loadPackageAlerts(root);
    loadWithdrawalReceipt(root);
    return true;
  }

  const api = { VERSION, esc, formatDate, integrityLabel, eventHtml, authoritativePackage, open, close, loadPackageAlerts, loadWithdrawalReceipt, install, version: VERSION };

  if (typeof document !== 'undefined') {
    const start = () => install(root);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once:true });
    else start();
  }
  return api;
});
