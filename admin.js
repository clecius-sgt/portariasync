(function () {
  'use strict';

  const API_BASE = localStorage.getItem('apiBaseUrl') || '';
  let authToken = localStorage.getItem('authToken') || '';
  let currentUser = null;
  let refreshTimer = null;

  const $ = id => document.getElementById(id);

  async function api(path, options = {}, requireAuth = true) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (requireAuth && authToken) headers.Authorization = 'Bearer ' + authToken;
    const response = await fetch(API_BASE + path, { ...options, headers });
    let payload = {};
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) {
      const error = new Error(payload.error || payload.detail || ('Erro HTTP ' + response.status));
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function setStatus(id, text, type, descriptionId, description) {
    const element = $(id);
    if (element) {
      element.textContent = text;
      element.className = 'status ' + (type || 'neutral');
    }
    if (descriptionId && $(descriptionId)) $(descriptionId).textContent = description || '';
  }

  function boolText(value) {
    return value ? 'Sim' : 'Não';
  }

  function formatDate(value) {
    if (!value) return 'Não informado';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('pt-BR');
  }

  function formatDuration(value) {
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms < 0) return '-';
    if (ms < 1000) return Math.round(ms) + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0).replace('.', ',') + ' s';
    return (ms / 60000).toFixed(1).replace('.', ',') + ' min';
  }

  function summarizeOcrMetrics(value, days = 30, now = new Date()) {
    const events = Array.isArray(value?.events) ? value.events : [];
    const cutoff = now.getTime() - Math.max(1, Number(days) || 30) * 86400000;
    const filtered = events
      .filter(event => event && Number.isFinite(Date.parse(event.at)) && Date.parse(event.at) >= cutoff)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const total = filtered.length;
    const count = predicate => filtered.filter(predicate).length;
    const mobile = count(event => event.route === 'mobile');
    const serverFallback = count(event => event.route === 'server-fallback');
    const degraded = count(event => event.route === 'mobile-degraded');
    const failed = count(event => event.failed || event.route === 'failed');
    const addressResolved = count(event => event.addressResolved);
    const candidateFound = count(event => event.candidateFound);
    const pct = amount => total ? Math.round(amount * 1000 / total) / 10 : 0;
    const average = key => {
      const values = filtered.map(event => Number(event[key])).filter(number => Number.isFinite(number) && number >= 0);
      return values.length ? Math.round(values.reduce((sum, number) => sum + number, 0) / values.length) : null;
    };
    const serverTimes = filtered
      .filter(event => event.fallbackUsed)
      .map(event => Number(event.serverElapsedMs))
      .filter(number => Number.isFinite(number) && number >= 0);
    return {
      total,
      mobile,
      serverFallback,
      degraded,
      failed,
      addressRate: pct(addressResolved),
      candidateRate: pct(candidateFound),
      fallbackRate: pct(serverFallback),
      failureRate: pct(failed),
      avgElapsedMs: average('elapsedMs'),
      avgServerElapsedMs: serverTimes.length ? Math.round(serverTimes.reduce((sum, number) => sum + number, 0) / serverTimes.length) : null,
      lastAt: filtered[0]?.at || null
    };
  }

  function renderOcrMetrics(state) {
    const metrics = state?.configPublica?.metricasOcr || {};
    const summary = summarizeOcrMetrics(metrics, 30);
    $('ocrMetricTotal').textContent = summary.total;
    $('ocrMetricAddressRate').textContent = summary.addressRate.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
    $('ocrMetricFallbackRate').textContent = summary.fallbackRate.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
    $('ocrMetricAvgTime').textContent = formatDuration(summary.avgElapsedMs);
    $('ocrMetricMobile').textContent = summary.mobile;
    $('ocrMetricServer').textContent = summary.serverFallback;
    $('ocrMetricDegraded').textContent = summary.degraded;
    $('ocrMetricFailed').textContent = summary.failed;
    $('ocrMetricCandidateRate').textContent = summary.candidateRate.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
    $('ocrMetricServerTime').textContent = formatDuration(summary.avgServerElapsedMs);
    $('ocrMetricLastAt').textContent = summary.lastAt ? formatDate(summary.lastAt) : 'Sem dados';

    if (!summary.total) {
      $('ocrMetricsNote').textContent = 'Ainda não há leituras contabilizadas. As métricas começam a ser acumuladas a partir desta atualização do PortalSync.';
    } else {
      $('ocrMetricsNote').textContent = 'Nos últimos 30 dias, ' + summary.addressRate.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) +
        '% das leituras reconheceram um endereço do cadastro e ' + summary.fallbackRate.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) +
        '% precisaram do PaddleOCR. Falhas: ' + summary.failed + '.';
    }
  }

  function showLogin(message) {
    $('authGate').style.display = 'flex';
    $('adminContent').style.display = 'none';
    if (message) {
      $('loginError').textContent = message;
      $('loginError').style.display = 'block';
    }
  }

  function showPanel(user) {
    currentUser = user;
    $('authGate').style.display = 'none';
    $('adminContent').style.display = 'block';
    $('adminUser').textContent = user ? (user.nome + ' · administrador') : 'Administrador';
  }

  async function loadUsers() {
    const select = $('loginUser');
    try {
      const payload = await api('/api/users', {}, false);
      const users = Array.isArray(payload.users) ? payload.users : [];
      select.innerHTML = '';
      const admins = users.filter(user => user.perfil === 'admin');
      const options = admins.length ? admins : users;
      for (const user of options) {
        const option = document.createElement('option');
        option.value = user.id;
        option.textContent = user.nome + (user.perfil ? ' (' + user.perfil + ')' : '');
        select.appendChild(option);
      }
      if (!options.length) select.innerHTML = '<option value="">Nenhum usuário disponível</option>';
    } catch (error) {
      select.innerHTML = '<option value="">Falha ao carregar usuários</option>';
      $('loginError').textContent = error.message;
      $('loginError').style.display = 'block';
    }
  }

  async function verifyCurrentSession() {
    if (!authToken) return false;
    try {
      const payload = await api('/api/auth/me');
      if (!payload.user || payload.user.perfil !== 'admin') {
        $('accessDenied').textContent = 'Este painel é restrito ao perfil administrador.';
        $('accessDenied').style.display = 'block';
        return false;
      }
      showPanel(payload.user);
      await refreshDashboard();
      startAutoRefresh();
      return true;
    } catch (_) {
      authToken = '';
      localStorage.removeItem('authToken');
      return false;
    }
  }

  async function login() {
    const button = $('loginButton');
    const errorBox = $('loginError');
    const denied = $('accessDenied');
    errorBox.style.display = 'none';
    denied.style.display = 'none';
    const id = $('loginUser').value;
    const senha = $('loginPassword').value;
    if (!id || !senha) {
      errorBox.textContent = 'Selecione o usuário e informe a senha.';
      errorBox.style.display = 'block';
      return;
    }
    button.disabled = true;
    button.textContent = 'Entrando...';
    try {
      const payload = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ id, senha })
      }, false);
      if (!payload.user || payload.user.perfil !== 'admin') {
        throw new Error('Acesso restrito ao administrador.');
      }
      authToken = payload.token || '';
      localStorage.setItem('authToken', authToken);
      $('loginPassword').value = '';
      showPanel(payload.user);
      await refreshDashboard();
      startAutoRefresh();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.style.display = 'block';
    } finally {
      button.disabled = false;
      button.textContent = 'Entrar no painel';
    }
  }

  function summarizeState(state) {
    const residents = Array.isArray(state.moradores) ? state.moradores : [];
    const packages = Array.isArray(state.encomendas) ? state.encomendas : [];
    const audit = Array.isArray(state.auditoria) ? state.auditoria : [];
    const pending = packages.filter(item => item && item.status === 'pendente').length;
    const done = packages.filter(item => item && item.status === 'retirado').length;
    return { residents, packages, audit, pending, done };
  }

  function renderHealth(health, state, users) {
    setStatus('statusApp', health && health.ok ? 'ONLINE' : 'INDISPONÍVEL', health && health.ok ? 'ok' : 'bad',
      'statusAppDesc', health && health.ok ? 'PortariaSync respondendo normalmente.' : 'O servidor não respondeu corretamente.');

    const ocr = (health && health.paddleocr) || {};
    if (!ocr.installed) {
      setStatus('statusOcr', 'NÃO INSTALADO', 'bad', 'statusOcrDesc', 'PaddleOCR não foi localizado no VPS.');
    } else if (ocr.running && ocr.ready) {
      setStatus('statusOcr', 'ONLINE', 'ok', 'statusOcrDesc', 'PaddleOCR carregado e pronto para novas etiquetas.');
    } else if (ocr.running && !ocr.ready) {
      setStatus('statusOcr', 'INICIANDO', 'warn', 'statusOcrDesc', 'Processo ativo, aguardando o modelo ficar pronto.');
    } else {
      setStatus('statusOcr', 'EM ESPERA', 'warn', 'statusOcrDesc', 'Instalado. Será iniciado automaticamente na próxima leitura.');
    }

    const storage = String(state.storage || (health.supabase ? 'supabase' : 'local')).toLowerCase();
    if (storage.includes('supabase')) {
      setStatus('statusData', 'SUPABASE', 'ok', 'statusDataDesc', 'Dados persistidos com armazenamento remoto ativo.');
    } else {
      setStatus('statusData', 'LOCAL', 'warn', 'statusDataDesc', 'Dados persistidos no próprio VPS. Supabase não está configurado.');
    }

    if (health.whatsapp) {
      setStatus('statusWhats', 'ATIVO', 'ok', 'statusWhatsDesc', 'Integração de WhatsApp configurada.');
    } else {
      setStatus('statusWhats', 'NÃO CONFIGURADO', 'warn', 'statusWhatsDesc', 'O sistema funciona normalmente, mas o envio via WhatsApp não está configurado.');
    }

    const summary = summarizeState(state);
    $('countResidents').textContent = summary.residents.length;
    $('countPending').textContent = summary.pending;
    $('countDone').textContent = summary.done;
    $('countTotal').textContent = summary.packages.length;
    renderOcrMetrics(state);

    $('ocrInstalled').textContent = boolText(ocr.installed);
    $('ocrRunning').textContent = ocr.running ? 'Em execução' : 'Em espera';
    $('ocrReady').textContent = ocr.ready ? 'Pronto' : 'Não carregado';
    $('ocrPending').textContent = Number(ocr.pending || 0);
    $('storageMode').textContent = state.storage || (health.supabase ? 'supabase' : 'local');
    $('stateUpdated').textContent = formatDate(state.updatedAt);
    $('countUsers').textContent = Array.isArray(users) ? users.length : '-';
    $('countAudit').textContent = summary.audit.length;

    if (ocr.running && ocr.ready) {
      $('ocrNote').textContent = 'Leitor operacional. O modelo está carregado na memória do VPS e pronto para processar novas fotografias.';
    } else if (ocr.installed) {
      $('ocrNote').textContent = 'Leitor instalado e em espera. Isso é normal após reinício do PortariaSync; ele será carregado automaticamente quando uma etiqueta for fotografada.';
    } else {
      $('ocrNote').textContent = 'O PaddleOCR não foi localizado. É necessário revisar a instalação no VPS antes de novas leituras.';
    }
  }

  async function refreshDashboard() {
    if (!authToken) return showLogin('Sessão não encontrada.');
    $('refreshButton').disabled = true;
    $('refreshOcrButton').disabled = true;
    try {
      const [health, state, usersPayload] = await Promise.all([
        api('/api/health', {}, false),
        api('/api/app-state'),
        api('/api/users', {}, false)
      ]);
      renderHealth(health, state || {}, usersPayload.users || []);
      $('lastRefresh').textContent = 'Atualizado em ' + new Date().toLocaleString('pt-BR');
    } catch (error) {
      if (error.status === 403) {
        stopAutoRefresh();
        authToken = '';
        localStorage.removeItem('authToken');
        return showLogin('Sua sessão expirou ou não possui permissão de administrador.');
      }
      setStatus('statusApp', 'ERRO', 'bad', 'statusAppDesc', error.message);
      $('lastRefresh').textContent = 'Falha na atualização: ' + error.message;
    } finally {
      $('refreshButton').disabled = false;
      $('refreshOcrButton').disabled = false;
    }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(refreshDashboard, 15000);
  }

  function stopAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  async function logout() {
    stopAutoRefresh();
    try { if (authToken) await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
    authToken = '';
    currentUser = null;
    localStorage.removeItem('authToken');
    $('adminUser').textContent = '';
    await loadUsers();
    showLogin('Sessão encerrada.');
  }

  async function boot() {
    $('loginButton').addEventListener('click', login);
    $('loginPassword').addEventListener('keydown', event => {
      if (event.key === 'Enter') login();
    });
    $('refreshButton').addEventListener('click', refreshDashboard);
    $('refreshOcrButton').addEventListener('click', refreshDashboard);
    $('logoutButton').addEventListener('click', logout);

    await loadUsers();
    const ok = await verifyCurrentSession();
    if (!ok) showLogin();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
