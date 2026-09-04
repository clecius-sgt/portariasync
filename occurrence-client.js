(function(root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OccurrenceUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';

  const VERSION = '2026-09-04.1';
  let snapshot = { byPackage:{} };
  let timer = null;

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function packageOccurrenceCount(id) {
    return Number(snapshot.byPackage[String(id || '')] || 0);
  }

  function buttonHtml(id) {
    const count = packageOccurrenceCount(id);
    const label = count ? `Ocorrências (${count})` : 'Abrir ocorrência';
    const encoded = encodeURIComponent(String(id || ''));
    return `<a class="btn btn-sm" style="background:#fff3cd;color:#856404;text-decoration:none;" href="/ocorrencias.html?package=${encoded}">${esc(label)}</a>`;
  }

  function installShortcut() {
    const doc = root?.document;
    const page = doc?.getElementById?.('page-config');
    if (!page || doc.getElementById('occurrenceCenterShortcut')) return false;
    const card = doc.createElement('div');
    card.className = 'card';
    card.id = 'occurrenceCenterShortcut';
    card.innerHTML = '<h2>Central de Ocorrências</h2><p style="color:var(--muted);font-size:13px;line-height:1.5;margin-bottom:12px;">Registre e acompanhe contestações, danos, divergências e outras ocorrências relacionadas às encomendas.</p><a class="btn btn-primary" href="/ocorrencias.html" style="text-decoration:none;">Abrir Central de Ocorrências</a>';
    page.appendChild(card);
    return true;
  }

  async function refresh() {
    if (typeof root?.apiFetch !== 'function') return false;
    try {
      const data = await root.apiFetch('/api/occurrences');
      const byPackage = {};
      for (const item of data?.occurrences || []) {
        const key = String(item?.packageId || '');
        if (!key) continue;
        byPackage[key] = Number(byPackage[key] || 0) + 1;
      }
      snapshot = { byPackage };
      try { root.renderEncomendas?.(); } catch (_) {}
      return true;
    } catch (_) {
      return false;
    }
  }

  function install(host) {
    root = host || root;
    if (!root || root.__occurrenceUiInstalled) return !!root;
    if (typeof root.itemEncomendaHTML !== 'function') {
      root.setTimeout?.(() => install(root), 300);
      return false;
    }
    root.__occurrenceUiInstalled = true;
    const original = root.itemEncomendaHTML;
    root.itemEncomendaHTML = function(item) {
      const html = String(original.apply(this, arguments) || '');
      const button = buttonHtml(item?.id);
      return html.replace(/<\/div>\s*$/, `<div class="actions" style="margin-top:8px;">${button}</div></div>`);
    };
    installShortcut();
    refresh();
    timer = root.setInterval?.(() => refresh(), 3 * 60 * 1000) || null;
    return true;
  }

  function stop() {
    if (timer && root?.clearInterval) root.clearInterval(timer);
    timer = null;
  }

  return { VERSION, esc, packageOccurrenceCount, buttonHtml, refresh, install, stop, version:VERSION };
});
