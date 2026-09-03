(function(root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./recipient-matching'));
  else root.RecipientMemory = factory(root.RecipientMatching);
})(typeof globalThis !== 'undefined' ? globalThis : this, function(Matching) {
  'use strict';

  const STORAGE_KEY = 'memoriaDestinatariosConfirmados';
  const STATE_KEY = 'memoriaDestinatariosConfirmados';
  const MAX_ENTRIES = 500;

  function normalizeName(value) {
    return Matching && typeof Matching.normalize === 'function'
      ? Matching.normalize(value)
      : String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function canonicalAddress(value) {
    if (!Matching || typeof Matching.address !== 'function') return null;
    const parsed = Matching.address(value);
    if (!parsed) return null;
    const unit = Object.keys(parsed.unit || {}).sort().map(key => key + '=' + parsed.unit[key]).join('&');
    return {
      parsed,
      key: [parsed.street, parsed.number, unit].join('|'),
      text: String(value || '').trim()
    };
  }

  function fingerprint(name, addressText) {
    const normalizedName = normalizeName(name);
    const addr = canonicalAddress(addressText);
    if (!addr || normalizedName.length < 3) return null;
    return {
      key: normalizedName + '||' + addr.key,
      normalizedName,
      address: addr
    };
  }

  function emptyMemory() {
    return { version: 1, entries: {} };
  }

  function normalizeMemory(value) {
    if (!value || typeof value !== 'object') return emptyMemory();
    const entries = value.entries && typeof value.entries === 'object' ? value.entries : {};
    return { version: 1, entries: { ...entries } };
  }

  function record(memory, observation, now = new Date()) {
    memory = normalizeMemory(memory);
    const resident = observation && observation.resident;
    const nameRead = String(observation?.nameRead || '').trim();
    const addressRead = String(observation?.addressRead || '').trim();
    if (!resident || !resident.id || !resident.casa || !nameRead || !addressRead) return { memory, saved: false, reason: 'incomplete' };

    const fp = fingerprint(nameRead, addressRead);
    const residentAddress = canonicalAddress(resident.casa);
    if (!fp || !residentAddress) return { memory, saved: false, reason: 'unparsed' };
    if (!Matching || typeof Matching.addressRelation !== 'function') return { memory, saved: false, reason: 'matcher-missing' };
    if (Matching.addressRelation(fp.address.parsed, residentAddress.parsed) !== 'exact') {
      return { memory, saved: false, reason: 'address-mismatch' };
    }

    const previous = memory.entries[fp.key];
    const sameResident = previous && String(previous.residentId) === String(resident.id);
    memory.entries[fp.key] = {
      key: fp.key,
      observedName: fp.normalizedName,
      observedAddress: fp.address.text,
      addressKey: fp.address.key,
      residentId: String(resident.id),
      residentName: resident.nome || '',
      residentAddress: resident.casa || '',
      confirmations: sameResident ? Math.max(1, Number(previous.confirmations || 0)) + 1 : 1,
      lastConfirmedAt: now.toISOString()
    };
    trim(memory);
    return { memory, saved: true, entry: memory.entries[fp.key] };
  }

  function trim(memory) {
    memory = normalizeMemory(memory);
    const entries = Object.values(memory.entries);
    if (entries.length <= MAX_ENTRIES) return memory;
    entries.sort((a, b) => Date.parse(b.lastConfirmedAt || 0) - Date.parse(a.lastConfirmedAt || 0));
    memory.entries = Object.fromEntries(entries.slice(0, MAX_ENTRIES).map(entry => [entry.key, entry]));
    return memory;
  }

  function findEntry(memory, result) {
    memory = normalizeMemory(memory);
    const fp = fingerprint(result?.nomeExtraido || '', result?.enderecoExtraido || '');
    if (!fp) return null;
    return memory.entries[fp.key] || null;
  }

  function apply(memory, result) {
    if (!result || typeof result !== 'object') return result;
    const entry = findEntry(memory, result);
    if (!entry) return result;
    const candidates = Array.isArray(result.candidatos) ? [...result.candidatos] : [];
    const rememberedIndex = candidates.findIndex(c => String(c?.morador?.id) === String(entry.residentId));
    if (rememberedIndex < 0) return result;

    const remembered = candidates[rememberedIndex];
    const currentAddress = canonicalAddress(remembered.morador?.casa || '');
    const extractedAddress = canonicalAddress(result.enderecoExtraido || '');
    const savedAddress = canonicalAddress(entry.residentAddress || '');
    if (!currentAddress || !extractedAddress || !savedAddress) return result;
    if (Matching.addressRelation(currentAddress.parsed, extractedAddress.parsed) !== 'exact') return result;
    if (Matching.addressRelation(currentAddress.parsed, savedAddress.parsed) !== 'exact') return result;

    candidates.splice(rememberedIndex, 1);
    candidates.unshift({ ...remembered, memoriaConfirmada: true, confirmacoesMemoria: Number(entry.confirmations || 1) });
    result.candidatos = candidates;
    result.candidatoPrincipal = remembered.morador;
    result.memoriaConfirmada = true;
    result.memoriaConfirmacoes = Number(entry.confirmations || 1);
    result.memoriaUltimaConfirmacao = entry.lastConfirmedAt || null;
    return result;
  }

  function merge(localValue, remoteValue) {
    const local = normalizeMemory(localValue);
    const remote = normalizeMemory(remoteValue);
    const merged = emptyMemory();
    const keys = new Set([...Object.keys(local.entries), ...Object.keys(remote.entries)]);
    for (const key of keys) {
      const a = local.entries[key];
      const b = remote.entries[key];
      if (!a) { merged.entries[key] = b; continue; }
      if (!b) { merged.entries[key] = a; continue; }
      if (String(a.residentId) !== String(b.residentId)) {
        const ta = Date.parse(a.lastConfirmedAt || 0) || 0;
        const tb = Date.parse(b.lastConfirmedAt || 0) || 0;
        merged.entries[key] = tb >= ta ? b : a;
        continue;
      }
      const newer = (Date.parse(b.lastConfirmedAt || 0) || 0) >= (Date.parse(a.lastConfirmedAt || 0) || 0) ? b : a;
      merged.entries[key] = { ...newer, confirmations: Math.max(Number(a.confirmations || 0), Number(b.confirmations || 0), 1) };
    }
    return trim(merged);
  }

  function load(host) {
    try {
      const raw = host?.localStorage?.getItem(STORAGE_KEY);
      return normalizeMemory(raw ? JSON.parse(raw) : null);
    } catch (_) {
      return emptyMemory();
    }
  }

  function save(host, memory) {
    memory = trim(normalizeMemory(memory));
    try { host?.localStorage?.setItem(STORAGE_KEY, JSON.stringify(memory)); } catch (_) {}
    return memory;
  }

  function decorateMemoryHint(host) {
    const modal = host?.document?.getElementById('modalSugestaoMorador');
    const result = modal?._resultado;
    if (!modal || !result?.memoriaConfirmada) return false;
    const container = modal.querySelector?.('#listaSugestoesModal');
    const first = container?.firstElementChild;
    if (!first || first.querySelector?.('[data-recipient-memory-hint="1"]')) return false;
    const badge = host.document.createElement('div');
    badge.dataset.recipientMemoryHint = '1';
    badge.style.cssText = 'display:inline-block;margin:6px 0 8px;padding:5px 8px;border-radius:999px;background:#e6f4ea;color:#137333;font-size:12px;font-weight:700;';
    const count = Math.max(1, Number(result.memoriaConfirmacoes || 1));
    badge.textContent = '✓ Destinatário já confirmado ' + count + (count === 1 ? ' vez' : ' vezes') + ' neste nome e endereço';
    first.insertBefore(badge, first.lastElementChild || null);
    return true;
  }

  function install(host) {
    host = host || root;
    if (!host || host.__recipientMemoryInstalled) return !!host;
    if (!Matching || typeof Matching.address !== 'function') return false;
    host.__recipientMemoryInstalled = true;
    let memory = load(host);

    if (typeof host.identificarMoradorOCR === 'function') {
      const originalIdentify = host.identificarMoradorOCR;
      if (!originalIdentify.__recipientMemoryWrapped) {
        const wrappedIdentify = function(text) {
          return apply(memory, originalIdentify.call(this, text));
        };
        wrappedIdentify.__recipientMemoryWrapped = true;
        wrappedIdentify.__original = originalIdentify;
        host.identificarMoradorOCR = wrappedIdentify;
      }
    }

    if (typeof host.selecionarMoradorSugestao === 'function') {
      const originalSelect = host.selecionarMoradorSugestao;
      if (!originalSelect.__recipientMemoryWrapped) {
        const wrappedSelect = function(id) {
          try {
            const modal = host.document?.getElementById('modalSugestaoMorador');
            const result = modal?._resultado;
            const candidates = Array.isArray(result?.candidatos) ? result.candidatos : [];
            const candidate = candidates.find(c => String(c?.morador?.id) === String(id));
            if (candidate?.morador) {
              const learned = record(memory, {
                resident: candidate.morador,
                nameRead: result?.nomeExtraido || '',
                addressRead: result?.enderecoExtraido || ''
              });
              memory = learned.memory;
              if (learned.saved) {
                memory = save(host, memory);
                try { if (typeof host.agendarSyncEstadoServidor === 'function') host.agendarSyncEstadoServidor(); } catch (_) {}
              }
            }
          } catch (error) {
            if (host.console?.warn) host.console.warn('Não foi possível memorizar o destinatário confirmado:', error);
          }
          return originalSelect.call(this, id);
        };
        wrappedSelect.__recipientMemoryWrapped = true;
        wrappedSelect.__original = originalSelect;
        host.selecionarMoradorSugestao = wrappedSelect;
      }
    }

    if (typeof host.filtrarModalSugestao === 'function') {
      const originalFilter = host.filtrarModalSugestao;
      if (!originalFilter.__recipientMemoryWrapped) {
        const wrappedFilter = function(q) {
          const value = originalFilter.call(this, q);
          if (!normalizeName(q)) decorateMemoryHint(host);
          return value;
        };
        wrappedFilter.__recipientMemoryWrapped = true;
        wrappedFilter.__original = originalFilter;
        host.filtrarModalSugestao = wrappedFilter;
      }
    }

    if (typeof host.montarEstadoApp === 'function') {
      const originalBuildState = host.montarEstadoApp;
      if (!originalBuildState.__recipientMemoryWrapped) {
        const wrappedBuildState = function() {
          const state = originalBuildState.call(this);
          state.configPublica = { ...(state.configPublica || {}), [STATE_KEY]: memory };
          return state;
        };
        wrappedBuildState.__recipientMemoryWrapped = true;
        wrappedBuildState.__original = originalBuildState;
        host.montarEstadoApp = wrappedBuildState;
      }
    }

    if (typeof host.aplicarEstadoApp === 'function') {
      const originalApplyState = host.aplicarEstadoApp;
      if (!originalApplyState.__recipientMemoryWrapped) {
        const wrappedApplyState = function(state) {
          const value = originalApplyState.call(this, state);
          const remote = state?.configPublica?.[STATE_KEY];
          if (remote && typeof remote === 'object') {
            const before = JSON.stringify(memory);
            memory = save(host, merge(memory, remote));
            if (JSON.stringify(memory) !== before) {
              try { if (typeof host.agendarSyncEstadoServidor === 'function') host.agendarSyncEstadoServidor(); } catch (_) {}
            }
          }
          return value;
        };
        wrappedApplyState.__recipientMemoryWrapped = true;
        wrappedApplyState.__original = originalApplyState;
        host.aplicarEstadoApp = wrappedApplyState;
      }
    }

    host.RecipientMemoryRuntime = {
      get: () => normalizeMemory(memory),
      clear: () => { memory = save(host, emptyMemory()); return memory; },
      version: '2026-09-02.2'
    };
    return true;
  }

  const api = {
    STORAGE_KEY,
    STATE_KEY,
    MAX_ENTRIES,
    normalizeName,
    canonicalAddress,
    fingerprint,
    emptyMemory,
    normalizeMemory,
    record,
    findEntry,
    apply,
    merge,
    load,
    save,
    decorateMemoryHint,
    install,
    version: '2026-09-02.2'
  };

  if (typeof document !== 'undefined') {
    const start = () => install(root);
    if (document.readyState === 'loading' && document.addEventListener) document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }

  return api;
});