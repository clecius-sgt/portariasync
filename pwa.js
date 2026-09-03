(function(root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.PortariaSyncPWA = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const VERSION = '2026-09-03.3';
  const MANIFEST_URL = '/manifest.json?v=20260903-1';
  const SW_URL = '/sw.js?v=20260903-2';
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

  function isAndroid(host) {
    return /Android/i.test(String(host?.navigator?.userAgent || ''));
  }

  function removeInstallButton(doc) {
    const button = doc?.getElementById?.('portariaPwaInstall');
    if (button?.remove) button.remove();
  }

  function manualInstallMessage(host) {
    if (isIos(host)) {
      return 'Para instalar o PortariaSync no iPhone/iPad: abra esta página no Safari, toque em Compartilhar e depois em “Adicionar à Tela de Início”.';
    }
    if (isAndroid(host)) {
      return 'Para instalar o PortariaSync no Android: toque no menu do navegador (⋮) e escolha “Instalar app” ou “Adicionar à tela inicial”.';
    }
    return 'Para instalar o PortariaSync, abra o menu do navegador e escolha “Instalar aplicativo” ou “Adicionar à tela inicial”.';
  }

  function currentInstallMode(host) {
    if (installPrompt) return 'prompt';
    if (isIos(host)) return 'ios';
    return 'manual';
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
      button.style.cssText = 'position:fixed;right:14px;bottom:max(14px,env(safe-area-inset-bottom));z-index:100500;border:0;border-radius:999px;padding:12px 17px;background:#c9a84c;color:#1a1f3a;font:800 13px Inter,Segoe UI,Arial,sans-serif;box-shadow:0 5px 18px rgba(0,0,0,.32);cursor:pointer;';
      doc.body.appendChild(button);
    }
    button.dataset.installMode = mode || currentInstallMode(host);
    button.disabled = false;
    button.onclick = async function() {
      const activeMode = installPrompt ? 'prompt' : button.dataset.installMode;
      if (activeMode !== 'prompt' || !installPrompt) {
        host.alert?.(manualInstallMessage(host));
        return;
      }

      const prompt = installPrompt;
      button.disabled = true;
      try {
        await prompt.prompt();
        const choice = await prompt.userChoice;
        installPrompt = null;
        if (choice?.outcome === 'accepted') removeInstallButton(doc);
        else {
          button.dataset.installMode = currentInstallMode(host);
          button.disabled = false;
        }
      } catch (_) {
        installPrompt = null;
        button.dataset.installMode = currentInstallMode(host);
        button.disabled = false;
        host.alert?.(manualInstallMessage(host));
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

  function loadWhatsappClient(host) {
    host = host || root;
    const doc = host?.document;
    if (!doc || typeof doc.createElement !== 'function') return false;
    if (host.PortariaSyncWhatsApp) {
      if (typeof host.PortariaSyncWhatsApp.install === 'function') host.PortariaSyncWhatsApp.install(host);
      return true;
    }
    if (doc.querySelector?.('script[data-portaria-whatsapp="1"]')) return true;
    const script = doc.createElement('script');
    script.src = '/whatsapp-client.js?v=20260903-1';
    script.async = true;
    script.dataset.portariaWhatsapp = '1';
    script.onload = function() {
      if (host.PortariaSyncWhatsApp && typeof host.PortariaSyncWhatsApp.install === 'function') host.PortariaSyncWhatsApp.install(host);
    };
    (doc.head || doc.documentElement).appendChild(script);
    return true;
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

    const showFallbackInstall = () => {
      if (!isStandalone(host)) showInstallButton(host, currentInstallMode(host));
    };
    if (doc.readyState === 'loading') {
      doc.addEventListener?.('DOMContentLoaded', showFallbackInstall, { once: true });
    } else {
      showFallbackInstall();
    }

    registerServiceWorker(host);
    loadWhatsappClient(host);
    host.PortariaSyncPwaRuntime = {
      version: VERSION,
      standalone: () => isStandalone(host),
      installMode: () => currentInstallMode(host),
      showInstall: () => showInstallButton(host, currentInstallMode(host)),
      register: () => registerServiceWorker(host),
      whatsappClient: () => loadWhatsappClient(host)
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
    isAndroid,
    manualInstallMessage,
    currentInstallMode,
    showInstallButton,
    registerServiceWorker,
    loadWhatsappClient,
    install,
    version: VERSION
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => install(root), { once: true });
    else install(root);
  }

  return api;
});