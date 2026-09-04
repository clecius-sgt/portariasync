(function(root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.PortariaSyncPWA = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const VERSION = '2026-09-03.7';
  const MANIFEST_URL = '/manifest.json?v=20260903-1';
  const SW_URL = '/sw.js?v=20260903-4';
  const ASSOCIATION_STATE_KEYS = [
    'moradores','encomendas','retirantesRelacionados','auditoria','memoriaRemetentes','config',
    'detalhesRetirada','estadoServidorVersion','ultimaSincronizacaoOk','resetEncomendasAplicado'
  ];
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

  function applyAssociationScope(host, associationId) {
    host = host || root;
    const storage = host?.localStorage;
    const id = String(associationId || '').trim();
    if (!storage || !id) return false;
    const current = String(storage.getItem('activeAssociationId') || '');
    if (current === id) return false;
    for (const key of ASSOCIATION_STATE_KEYS) storage.removeItem(key);
    storage.setItem('activeAssociationId', id);
    return true;
  }

  function installAssociationScope(host) {
    host = host || root;
    if (!host?.fetch || host.__portariaAssociationScopeInstalled) return false;
    host.__portariaAssociationScopeInstalled = true;
    const originalFetch = host.fetch.bind(host);
    host.fetch = async function(input, options) {
      const response = await originalFetch(input, options);
      try {
        const url = typeof input === 'string' ? input : String(input?.url || '');
        if (response.ok && (/\/api\/auth\/login(?:\?|$)/.test(url) || /\/api\/auth\/me(?:\?|$)/.test(url))) {
          const payload = await response.clone().json();
          const changed = applyAssociationScope(host, payload?.user?.associacaoId);
          if (changed && /\/api\/auth\/login(?:\?|$)/.test(url)) {
            if (payload?.token) host.localStorage?.setItem('authToken', payload.token);
            host.setTimeout?.(() => host.location?.reload?.(), 0);
          }
        }
      } catch (_) {}
      return response;
    };
    return true;
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
    script.src = '/whatsapp-client.js?v=20260903-2';
    script.async = true;
    script.dataset.portariaWhatsapp = '1';
    script.onload = function() {
      if (host.PortariaSyncWhatsApp && typeof host.PortariaSyncWhatsApp.install === 'function') host.PortariaSyncWhatsApp.install(host);
    };
    (doc.head || doc.documentElement).appendChild(script);
    return true;
  }

  function loadWithdrawalPin(host) {
    host = host || root;
    const doc = host?.document;
    if (!doc || typeof doc.createElement !== 'function') return false;
    if (host.WithdrawalPin) {
      if (typeof host.WithdrawalPin.install === 'function') host.WithdrawalPin.install(host);
      return true;
    }
    if (doc.querySelector?.('script[data-withdrawal-pin="1"]')) return true;
    const script = doc.createElement('script');
    script.src = '/withdrawal-pin.js?v=20260903-1';
    script.async = true;
    script.dataset.withdrawalPin = '1';
    script.onload = function() {
      if (host.WithdrawalPin && typeof host.WithdrawalPin.install === 'function') host.WithdrawalPin.install(host);
    };
    (doc.head || doc.documentElement).appendChild(script);
    return true;
  }

  function loadWithdrawalAuthorization(host) {
    host = host || root;
    const doc = host?.document;
    if (!doc || typeof doc.createElement !== 'function') return false;
    if (host.WithdrawalAuthorization) {
      if (typeof host.WithdrawalAuthorization.install === 'function') host.WithdrawalAuthorization.install(host);
      return true;
    }
    if (doc.querySelector?.('script[data-withdrawal-authorization="1"]')) return true;
    const script = doc.createElement('script');
    script.src = '/withdrawal-authorization.js?v=20260903-1';
    script.async = true;
    script.dataset.withdrawalAuthorization = '1';
    script.onload = function() {
      if (host.WithdrawalAuthorization && typeof host.WithdrawalAuthorization.install === 'function') host.WithdrawalAuthorization.install(host);
    };
    (doc.head || doc.documentElement).appendChild(script);
    return true;
  }

  function loadCustodyChain(host) {
    host = host || root;
    const doc = host?.document;
    if (!doc || typeof doc.createElement !== 'function') return false;
    if (host.CustodyChainUI) {
      if (typeof host.CustodyChainUI.install === 'function') host.CustodyChainUI.install(host);
      return true;
    }
    if (doc.querySelector?.('script[data-custody-chain="1"]')) return true;
    const script = doc.createElement('script');
    script.src = '/custody-chain-client.js?v=20260903-1';
    script.async = true;
    script.dataset.custodyChain = '1';
    script.onload = function() {
      if (host.CustodyChainUI && typeof host.CustodyChainUI.install === 'function') host.CustodyChainUI.install(host);
    };
    (doc.head || doc.documentElement).appendChild(script);
    return true;
  }

  function install(host) {
    host = host || root;
    const doc = host?.document;
    if (!doc || host.__portariaPwaInstalled) return !!doc;
    host.__portariaPwaInstalled = true;

    installAssociationScope(host);
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
    loadWithdrawalPin(host);
    loadWithdrawalAuthorization(host);
    loadCustodyChain(host);
    host.PortariaSyncPwaRuntime = {
      version: VERSION,
      standalone: () => isStandalone(host),
      installMode: () => currentInstallMode(host),
      showInstall: () => showInstallButton(host, currentInstallMode(host)),
      register: () => registerServiceWorker(host),
      whatsappClient: () => loadWhatsappClient(host),
      withdrawalPin: () => loadWithdrawalPin(host),
      withdrawalAuthorization: () => loadWithdrawalAuthorization(host),
      custodyChain: () => loadCustodyChain(host),
      associationScope: id => applyAssociationScope(host, id)
    };
    return true;
  }

  const api = {
    VERSION,
    MANIFEST_URL,
    SW_URL,
    ASSOCIATION_STATE_KEYS,
    ensureLink,
    ensureMeta,
    isStandalone,
    isIos,
    isAndroid,
    applyAssociationScope,
    installAssociationScope,
    manualInstallMessage,
    currentInstallMode,
    showInstallButton,
    registerServiceWorker,
    loadWhatsappClient,
    loadWithdrawalPin,
    loadWithdrawalAuthorization,
    loadCustodyChain,
    install,
    version: VERSION
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => install(root), { once: true });
    else install(root);
  }

  return api;
});
