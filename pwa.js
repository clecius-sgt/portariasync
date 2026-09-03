(function(root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.PortariaSyncPWA = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const VERSION = '2026-09-03.1';
  const MANIFEST_URL = '/manifest.json?v=20260903-1';
  const SW_URL = '/sw.js?v=20260903-1';
  let installPrompt = null;

  function ensureLink(doc, rel, href, extra = {}) {
    if (!doc || typeof doc.createElement !== 'function') return null;
    let link = doc.querySelector?.('link[rel="' + rel + '"]') || null;
    if (!link) {
      link = doc.createElement('link');
      link.rel = rel;
      (doc.head || doc.documentElement).appendChild(link);
    }
    link.href = href;
    Object.assign(link, extra);
    return link;
  }

  function ensureMeta(doc, name, content) {
    if (!doc || typeof doc.createElement !== 'function') return null;
    let meta = doc.querySelector?.('meta[name="' + name + '"]') || null;
    if (!meta) {
      meta = doc.createElement('meta');
      meta.name = name;
      (doc.head || doc.documentElement).appendChild(meta);
    }
    meta.content = content;
    return meta;
  }

  function isStandalone(host) {
    try {
      return !!(host?.matchMedia?.('(display-mode: standalone)').matches || host?.navigator?.standalone);
    } catch (_) {
      return false;
    }
  }

  function isIos(host) {
    const ua = String(host?.navigator?.userAgent || '');
    const platform = String(host?.navigator?.platform || '');
    return /iPad|iPhone|iPod/i.test(ua) || (platform === 'MacIntel' && Number(host?.navigator?.maxTouchPoints || 0) > 1);
  }

  function removeInstallButton(doc) {
    const button = doc?.getElementById?.('portariaPwaInstall');
    if (button?.remove) button.remove();
  }

  function showInstallButton(host, mode) {
    const doc = host?.document;
    if (!doc?.body || isStandalone(host)) return false;
    let button = doc.getElementById('portariaPwaInstall');
    if (!button) {
      button = doc.createElement('button');
      button.id = 'portariaPwaInstall';
      button.type = 'button';
      button.textContent = 'Instalar PortariaSync';
      button.setAttribute('aria-label', 'Instalar PortariaSync neste aparelho');
      button.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:11000;border:0;border-radius:999px;padding:11px 16px;background:#1a1f3a;color:#fff;font:700 13px Inter,Segoe UI,Arial,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);cursor:pointer;';
      doc.body.appendChild(button);
    }
    button.dataset.installMode = mode || 'prompt';
    button.onclick = async function() {
      if (button.dataset.installMode === 'ios') {
        host.alert?.('No Safari, toque em Compartilhar e depois em “Adicionar à Tela de Início”.');
        return;
      }
      const prompt = installPrompt;
      if (!prompt) return;
      button.disabled = true;
      try {
        await prompt.prompt();
        await prompt.userChoice;
      } catch (_) {
      } finally {
        installPrompt = null;
        removeInstallButton(doc);
      }
    };
    return true;
  }

  async function registerServiceWorker(host) {
    host = host || root;
    if (!host?.navigator?.serviceWorker || !host?.location) return null;
    if (host.location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(host.location.hostname)) return null;
    try {
      const registration = await host.navigator.serviceWorker.register(SW_URL, { scope: '/', updateViaCache: 'none' });
      try { await registration.update(); } catch (_) {}
      return registration;
    } catch (error) {
      host.console?.warn?.('PWA: service worker não pôde ser registrado:', error);
      return null;
    }
  }

  function install(host) {
    host = host || root;
    const doc = host?.document;
    if (!doc || host.__portariaPwaInstalled) return !!doc;
    host.__portariaPwaInstalled = true;

    ensureLink(doc, 'manifest', MANIFEST_URL);
    ensureLink(doc, 'icon', '/icons/portariasync-192.svg', { type: 'image/svg+xml' });
    ensureLink(doc, 'apple-touch-icon', '/icons/portariasync-192.svg');
    ensureMeta(doc, 'theme-color', '#1a1f3a');
    ensureMeta(doc, 'mobile-web-app-capable', 'yes');
    ensureMeta(doc, 'apple-mobile-web-app-capable', 'yes');
    ensureMeta(doc, 'apple-mobile-web-app-status-bar-style', 'default');
    ensureMeta(doc, 'apple-mobile-web-app-title', 'PortariaSync');

    if (isStandalone(host)) {
      doc.documentElement?.setAttribute?.('data-pwa-standalone', '1');
      removeInstallButton(doc);
    }

    host.addEventListener?.('beforeinstallprompt', event => {
      event.preventDefault?.();
      installPrompt = event;
      showInstallButton(host, 'prompt');
    });
    host.addEventListener?.('appinstalled', () => {
      installPrompt = null;
      doc.documentElement?.setAttribute?.('data-pwa-standalone', '1');
      removeInstallButton(doc);
    });

    if (isIos(host) && !isStandalone(host)) {
      const showIos = () => showInstallButton(host, 'ios');
      if (doc.readyState === 'loading') doc.addEventListener?.('DOMContentLoaded', showIos, { once: true });
      else showIos();
    }

    registerServiceWorker(host);
    host.PortariaSyncPwaRuntime = {
      version: VERSION,
      standalone: () => isStandalone(host),
      register: () => registerServiceWorker(host)
    };
    return true;
  }

  const api = {
    VERSION,
    MANIFEST_URL,
    SW_URL,
    ensureLink,
    ensureMeta,
    isStandalone,
    isIos,
    showInstallButton,
    registerServiceWorker,
    install,
    version: VERSION
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => install(root), { once: true });
    else install(root);
  }

  return api;
});
