(() => {
  'use strict';

  const API_BASE = localStorage.getItem('apiBaseUrl') || '';
  let authToken = localStorage.getItem('authToken') || '';
  let currentUser = null;
  let refreshTimer = null;
  const $ = id => document.getElementById(id);

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  async function api(path, options = {}, authenticated = true) {
    const headers = { ...(options.headers || {}) };
    if (options.body) headers['Content-Type'] = 'application/json';
    if (authenticated && authToken) headers.Authorization = 'Bearer ' + authToken;
    const response = await fetch(API_BASE + path, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || payload.detail || `Erro HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function showLogin(message = '') {
    $('authGate').style.display = 'flex';
    $('dashboardContent').style.display = 'none';
    if (message) {
      $('loginError').textContent = message;
      $('loginError').style.display = 'block';
    }
  }

  function showDashboard(user) {
    currentUser = user;
    $('authGate').style.display = 'none';
    $('dashboardContent').style.display = 'block';
    $('currentUser').textContent = `${user.nome} · ${user.perfil}`;
    $('adminLink').style.display = user.perfil === 'admin' ? '' : 'none';
  }

  async function loadUsers() {
    try {
      const payload = await api('/api/users', {}, false);
      const users = Array.isArray(payload.users) ? payload.users : [];
      $('loginUser').innerHTML = users.length
        ? users.map(user => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.nome)} (${escapeHtml(user.perfil)})</option>`).join('')
        : '<option value="">Nenhum usuário disponível</option>';
    } catch (error) {
      $('loginUser').innerHTML = '<option value="">Servidor indisponível</option>';
      showLogin(error.message);
    }
  }

  function formatDate(value) {
    if (!value) return 'Sem data';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Sem data' : date.toLocaleString('pt-BR');
  }

  function formatAge(value) {
    const hours = Number(value);
    if (!Number.isFinite(hours)) return 'Sem data';
    if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
    if (hours < 24) return `${Math.floor(hours)}h`;
    const days = Math.floor(hours / 24);
    const rest = Math.floor(hours % 24);
    return rest ? `${days}d ${rest}h` : `${days}d`;
  }

  function renderServices(status) {
    const rows = [
      ['Banco de dados', status.database, false],
      ['WhatsApp', status.whatsapp, false],
      ['Leitor OCR', status.ocr, !status.ocrReady],
      ['Alertas automáticos', status.alertsEnabled, false]
    ];
    $('services').innerHTML = rows.map(([label, active, warning]) => `<div class="service"><i class="dot ${active && !warning ? 'ok' : 'warn'}"></i><strong>${escapeHtml(label)}:</strong> ${active ? (warning ? 'aquecendo' : 'ativo') : 'indisponível'}</div>`).join('');
  }

  function renderAlerts(alerts) {
    const values = Array.isArray(alerts) ? alerts : [];
    $('alertCount').textContent = `${values.length} ${values.length === 1 ? 'alerta' : 'alertas'}`;
    $('alerts').innerHTML = values.length
      ? values.map(alert => `<div class="alert ${escapeHtml(alert.level)}"><strong>${escapeHtml(alert.title)}</strong><span>${escapeHtml(alert.detail)}</span></div>`).join('')
      : '<div class="clear">Nenhum alerta operacional neste momento.</div>';
  }

  function renderHourly(rows) {
    const values = Array.isArray(rows) ? rows : [];
    const max = Math.max(1, ...values.flatMap(row => [Number(row.received || 0), Number(row.withdrawn || 0)]));
    $('hourlyChart').innerHTML = values.map(row => {
      const received = Math.round(Number(row.received || 0) * 100 / max);
      const withdrawn = Math.round(Number(row.withdrawn || 0) * 100 / max);
      return `<div class="hour" title="${row.hour}h: ${row.received} recebida(s), ${row.withdrawn} retirada(s)"><i class="bar received" style="height:${received}%"></i><i class="bar withdrawn" style="height:${withdrawn}%"></i></div>`;
    }).join('');
  }

  function renderQueue(rows) {
    const values = Array.isArray(rows) ? rows : [];
    $('queueCount').textContent = `${values.length} ${values.length === 1 ? 'item' : 'itens'}`;
    $('queueBody').innerHTML = values.length ? values.map(item => `<tr><td><span class="badge ${escapeHtml(item.level)}">${escapeHtml(item.priority)}</span></td><td><strong>${escapeHtml(formatAge(item.ageHours))}</strong></td><td>${escapeHtml(formatDate(item.entryAt))}</td><td><strong>${escapeHtml(item.resident)}</strong></td><td>${escapeHtml(item.house)}</td><td>${escapeHtml(item.carrier)}</td><td>${escapeHtml(item.code)}</td></tr>`).join('') : '<tr><td colspan="7" class="empty">Nenhuma encomenda aguardando retirada.</td></tr>';
  }

  function renderRecent(rows) {
    const values = Array.isArray(rows) ? rows : [];
    $('recent').innerHTML = values.length ? values.slice(0, 12).map(item => `<div class="movement ${item.type === 'withdrawn' ? 'withdrawn' : ''}"><div class="movement-icon">${item.type === 'withdrawn' ? '✓' : '+'}</div><div><strong>${escapeHtml(item.resident)} · ${escapeHtml(item.code)}</strong><span>${item.type === 'withdrawn' ? 'Retirada' : 'Recebida'} em ${escapeHtml(formatDate(item.occurredAt))} · ${escapeHtml(item.house)}</span></div></div>`).join('') : '<div class="empty">Nenhuma movimentação registrada hoje.</div>';
  }

  function render(payload) {
    const summary = payload.summary || {};
    $('receivedToday').textContent = summary.receivedToday || 0;
    $('withdrawnToday').textContent = summary.withdrawnToday || 0;
    $('pendingTotal').textContent = summary.pending || 0;
    $('priorityTotal').textContent = summary.priority || 0;
    $('criticalTotal').textContent = summary.critical || 0;
    $('occurrenceTotal').textContent = summary.openOccurrences || 0;
    $('criticalRule').textContent = `${payload.policy?.criticalHours || 168}h ou mais`;
    $('associationName').textContent = payload.association?.nome || 'Associação de Moradores';
    $('updatedAt').textContent = `Atualizado em ${formatDate(payload.generatedAt)} · atualização automática em 30 segundos`;
    renderServices(payload.serviceStatus || {});
    renderAlerts(payload.alerts);
    renderHourly(payload.hourly);
    renderQueue(payload.queue);
    renderRecent(payload.recent);
    $('aging').innerHTML = (payload.aging || []).map(item => `<div class="age"><strong>${Number(item.count || 0)}</strong><span>${escapeHtml(item.label)}</span></div>`).join('');
  }

  async function refresh() {
    if (!authToken) return showLogin('Sessão não encontrada.');
    $('refreshButton').disabled = true;
    try {
      const timezoneOffset = -new Date().getTimezoneOffset();
      render(await api(`/api/dashboard/operational?tzOffset=${timezoneOffset}`));
    } catch (error) {
      if (error.status === 403) {
        authToken = '';
        localStorage.removeItem('authToken');
        stopAutoRefresh();
        return showLogin('Sua sessão expirou ou não possui permissão.');
      }
      $('updatedAt').textContent = `Falha na atualização: ${error.message}`;
    } finally {
      $('refreshButton').disabled = false;
    }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(() => { if (!document.hidden) refresh(); }, 30000);
  }

  function stopAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  async function verifySession() {
    if (!authToken) return false;
    try {
      const payload = await api('/api/auth/me');
      showDashboard(payload.user);
      await refresh();
      startAutoRefresh();
      return true;
    } catch (_) {
      authToken = '';
      localStorage.removeItem('authToken');
      return false;
    }
  }

  async function login() {
    $('loginError').style.display = 'none';
    const id = $('loginUser').value;
    const senha = $('loginPassword').value;
    if (!id || !senha) return showLogin('Selecione o usuário e informe a senha.');
    $('loginButton').disabled = true;
    try {
      const payload = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ id, senha }) }, false);
      authToken = payload.token || '';
      localStorage.setItem('authToken', authToken);
      $('loginPassword').value = '';
      showDashboard(payload.user);
      await refresh();
      startAutoRefresh();
    } catch (error) {
      showLogin(error.message);
    } finally {
      $('loginButton').disabled = false;
    }
  }

  async function logout() {
    stopAutoRefresh();
    try { if (authToken) await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
    authToken = '';
    currentUser = null;
    localStorage.removeItem('authToken');
    await loadUsers();
    showLogin('Sessão encerrada.');
  }

  async function boot() {
    $('loginButton').addEventListener('click', login);
    $('loginPassword').addEventListener('keydown', event => { if (event.key === 'Enter') login(); });
    $('refreshButton').addEventListener('click', refresh);
    $('logoutButton').addEventListener('click', logout);
    await loadUsers();
    if (!await verifySession()) showLogin();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
