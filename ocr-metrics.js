(function(root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.OcrMetrics = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const STORAGE_KEY = 'metricasOcr';
  const STATE_KEY = 'metricasOcr';
  const MAX_EVENTS = 2000;
  const RETENTION_DAYS = 60;
  const ROUTES = new Set(['mobile', 'server-fallback', 'mobile-degraded', 'failed']);

  function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function safeDate(value) {
    const time = Date.parse(value || '');
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  }

  function cleanEvent(value) {
    if (!value || typeof value !== 'object') return null;
    const at = safeDate(value.at);
    const id = String(value.id || '').trim();
    if (!id || !at) return null;
    const route = ROUTES.has(value.route) ? value.route : 'failed';
    return {
      id,
      at,
      route,
      engine: String(value.engine || '').slice(0, 40),
      elapsedMs: numberOrNull(value.elapsedMs),
      serverElapsedMs: numberOrNull(value.serverElapsedMs),
      fallbackUsed: !!value.fallbackUsed,
      failed: !!value.failed || route === 'failed',
      addressResolved: !!value.addressResolved,
      candidateFound: !!value.candidateFound,
      confident: !!value.confident
    };
  }

  function emptyStore() {
    return { version: 1, events: [] };
  }

  function normalizeStore(value, now = new Date()) {
    const source = Array.isArray(value?.events) ? value.events : [];
    const byId = new Map();
    for (const raw of source) {
      const event = cleanEvent(raw);
      if (!event) continue;
      const previous = byId.get(event.id);
      if (!previous || Date.parse(event.at) >= Date.parse(previous.at)) byId.set(event.id, event);
    }
    const cutoff = now.getTime() - RETENTION_DAYS * 86400000;
    const events = [...byId.values()]
      .filter(event => Date.parse(event.at) >= cutoff)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, MAX_EVENTS);
    return { version: 1, events };
  }

  function merge(localValue, remoteValue, now = new Date()) {
    const local = normalizeStore(localValue, now);
    const remote = normalizeStore(remoteValue, now);
    return normalizeStore({ events: [...local.events, ...remote.events] }, now);
  }

  function makeId(host, now) {
    try {
      if (host?.crypto?.randomUUID) return host.crypto.randomUUID();
    } catch (_) {}
    return String(now.getTime()) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function createEvent(input, host, now = new Date()) {
    return cleanEvent({
      id: input?.id || makeId(host, now),
      at: input?.at || now.toISOString(),
      route: input?.route,
      engine: input?.engine,
      elapsedMs: input?.elapsedMs,
      serverElapsedMs: input?.serverElapsedMs,
      fallbackUsed: input?.fallbackUsed,
      failed: input?.failed,
      addressResolved: input?.addressResolved,
      candidateFound: input?.candidateFound,
      confident: input?.confident
    });
  }

  function average(events, key) {
    const values = events.map(event => numberOrNull(event[key])).filter(value => value !== null);
    if (!values.length) return null;
    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  }

  function summarize(value, days = 30, now = new Date()) {
    const store = normalizeStore(value, now);
    const cutoff = now.getTime() - Math.max(1, Number(days) || 30) * 86400000;
    const events = store.events.filter(event => Date.parse(event.at) >= cutoff);
    const total = events.length;
    const mobile = events.filter(event => event.route === 'mobile').length;
    const serverFallback = events.filter(event => event.route === 'server-fallback').length;
    const fallbackAttempts = events.filter(event => event.fallbackUsed).length;
    const degraded = events.filter(event => event.route === 'mobile-degraded').length;
    const failed = events.filter(event => event.failed).length;
    const addressResolved = events.filter(event => event.addressResolved).length;
    const candidateFound = events.filter(event => event.candidateFound).length;
    const confident = events.filter(event => event.confident).length;
    const pct = count => total ? Math.round(count * 1000 / total) / 10 : 0;
    return {
      days: Math.max(1, Number(days) || 30),
      total,
      mobile,
      serverFallback,
      fallbackAttempts,
      degraded,
      failed,
      addressResolved,
      candidateFound,
      confident,
      addressRate: pct(addressResolved),
      candidateRate: pct(candidateFound),
      fallbackRate: pct(fallbackAttempts),
      failureRate: pct(failed),
      avgElapsedMs: average(events, 'elapsedMs'),
      avgServerElapsedMs: average(events.filter(event => event.fallbackUsed), 'serverElapsedMs'),
      lastAt: events[0]?.at || null
    };
  }

  function load(host) {
    try {
      const raw = host?.localStorage?.getItem(STORAGE_KEY);
      return normalizeStore(raw ? JSON.parse(raw) : null);
    } catch (_) {
      return emptyStore();
    }
  }

  function save(host, value) {
    const store = normalizeStore(value);
    try { host?.localStorage?.setItem(STORAGE_KEY, JSON.stringify(store)); } catch (_) {}
    return store;
  }

  function scheduleSync(host) {
    try {
      if (typeof host?.agendarSyncEstadoServidor === 'function') host.agendarSyncEstadoServidor();
    } catch (_) {}
  }

  function mergeRemoteState(host, state, appState, syncWhenChanged = true) {
    const remote = appState?.configPublica?.[STATE_KEY];
    if (!remote || typeof remote !== 'object') return false;
    const before = JSON.stringify(state.store);
    state.store = save(host, merge(state.store, remote));
    const changed = JSON.stringify(state.store) !== before;
    if (changed && syncWhenChanged) scheduleSync(host);
    return changed;
  }

  async function refreshRemote(host, state) {
    try {
      if (!host?.fetch || !host?.localStorage) return false;
      const token = host.localStorage.getItem('authToken') || '';
      if (!token) return false;
      const base = host.localStorage.getItem('apiBaseUrl') || '';
      const response = await host.fetch(base + '/api/app-state', {
        headers: { Authorization: 'Bearer ' + token }
      });
      if (!response.ok) return false;
      const appState = await response.json();
      return mergeRemoteState(host, state, appState, true);
    } catch (_) {
      return false;
    }
  }

  function installStateSync(host, state) {
    if (typeof host.montarEstadoApp === 'function' && !host.montarEstadoApp.__ocrMetricsWrapped) {
      const original = host.montarEstadoApp;
      const wrapped = function() {
        const appState = original.call(this);
        appState.configPublica = { ...(appState.configPublica || {}), [STATE_KEY]: state.store };
        return appState;
      };
      wrapped.__ocrMetricsWrapped = true;
      wrapped.__original = original;
      host.montarEstadoApp = wrapped;
    }

    if (typeof host.aplicarEstadoApp === 'function' && !host.aplicarEstadoApp.__ocrMetricsWrapped) {
      const original = host.aplicarEstadoApp;
      const wrapped = function(appState) {
        const result = original.call(this, appState);
        mergeRemoteState(host, state, appState, true);
        return result;
      };
      wrapped.__ocrMetricsWrapped = true;
      wrapped.__original = original;
      host.aplicarEstadoApp = wrapped;
    }
  }

  function installMatcherProbe(host, state) {
    const matching = host?.RecipientMatching;
    if (!matching || typeof matching.match !== 'function') return false;
    if (matching.match.__ocrMetricsProbe) return true;
    const original = matching.match;
    const wrapped = function(text, residents) {
      const result = original.call(this, text, residents);
      const active = state.active;
      if (active) {
        active.addressResolved = !!String(result?.enderecoExtraido || '').trim();
        active.candidateFound = !!result?.candidatoPrincipal || !!result?.candidatos?.length;
        active.confident = !!result?.confiavel;
      }
      return result;
    };
    wrapped.__ocrMetricsProbe = true;
    wrapped.__original = original;
    matching.match = wrapped;
    return true;
  }

  function installPaddleProbe(host, state) {
    const capture = host?.LabelCapture;
    if (!capture || typeof capture.recognizeWithPaddle !== 'function') return false;
    if (capture.recognizeWithPaddle.__ocrMetricsProbe) return true;
    const original = capture.recognizeWithPaddle;
    const wrapped = async function(...args) {
      const active = state.active;
      if (!active) return original.apply(this, args);
      active.serverUsed = true;
      const startedAt = Date.now();
      try {
        const result = await original.apply(this, args);
        active.serverSucceeded = true;
        return result;
      } catch (error) {
        active.serverFailed = true;
        throw error;
      } finally {
        active.serverElapsedMs = Date.now() - startedAt;
      }
    };
    wrapped.__ocrMetricsProbe = true;
    wrapped.__original = original;
    capture.recognizeWithPaddle = wrapped;
    return true;
  }

  function installOcrProbe(host, state, runtime) {
    if (!host || typeof host.enviarParaOCR !== 'function') return false;
    if (host.enviarParaOCR.__ocrMetricsProbe) return true;
    const original = host.enviarParaOCR;
    const wrapped = async function(...args) {
      if (args[5]) return original.apply(this, args);
      const active = {
        startedAt: Date.now(),
        serverUsed: false,
        serverSucceeded: false,
        serverFailed: false,
        serverElapsedMs: null,
        addressResolved: false,
        candidateFound: false,
        confident: false
      };
      state.active = active;
      let thrown = null;
      try {
        return await original.apply(this, args);
      } catch (error) {
        thrown = error;
        throw error;
      } finally {
        if (state.active === active) state.active = null;
        const noUsableResult = !active.addressResolved && !active.candidateFound;
        const failed = !!thrown || (active.serverUsed && active.serverFailed && noUsableResult);
        let route = 'mobile';
        if (failed) route = 'failed';
        else if (active.serverUsed && active.serverFailed) route = 'mobile-degraded';
        else if (active.serverUsed) route = 'server-fallback';
        else if (!active.addressResolved) route = 'mobile-degraded';
        runtime.record({
          route,
          engine: route === 'server-fallback' ? 'paddleocr' : (route === 'failed' ? 'unavailable' : 'tesseract-mobile'),
          elapsedMs: Date.now() - active.startedAt,
          serverElapsedMs: active.serverElapsedMs,
          fallbackUsed: active.serverUsed,
          failed,
          addressResolved: active.addressResolved,
          candidateFound: active.candidateFound,
          confident: active.confident
        });
      }
    };
    wrapped.__ocrMetricsProbe = true;
    wrapped.__original = original;
    host.enviarParaOCR = wrapped;
    return true;
  }

  function install(host) {
    host = host || root;
    if (!host) return false;
    if (host.OcrMetricsRuntime) return true;

    const state = { store: load(host), active: null };
    const runtime = {
      record(input) {
        const event = createEvent(input, host);
        if (!event) return null;
        state.store = save(host, { events: [event, ...state.store.events] });
        scheduleSync(host);
        return event;
      },
      get() { return normalizeStore(state.store); },
      summarize(days = 30) { return summarize(state.store, days); },
      clear() { state.store = save(host, emptyStore()); scheduleSync(host); return state.store; },
      version: '2026-09-02.2'
    };
    host.OcrMetricsRuntime = runtime;
    installStateSync(host, state);

    const attachProbes = () => {
      installMatcherProbe(host, state);
      installPaddleProbe(host, state);
      installOcrProbe(host, state, runtime);
    };
    attachProbes();
    refreshRemote(host, state);
    if (typeof host.setTimeout === 'function') {
      host.setTimeout(attachProbes, 0);
      host.setTimeout(attachProbes, 250);
      host.setTimeout(attachProbes, 1000);
    }
    return true;
  }

  return {
    STORAGE_KEY,
    STATE_KEY,
    MAX_EVENTS,
    RETENTION_DAYS,
    cleanEvent,
    emptyStore,
    normalizeStore,
    merge,
    createEvent,
    summarize,
    load,
    save,
    mergeRemoteState,
    refreshRemote,
    install,
    version: '2026-09-02.2'
  };
});