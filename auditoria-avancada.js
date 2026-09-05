(() => {
  'use strict';

  const API_BASE = localStorage.getItem('apiBaseUrl') || '';
  const $ = id => document.getElementById(id);
  let authToken = localStorage.getItem('authToken') || '';
  let currentReport = null;

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

  function allowed(user) {
    return !!user && ['admin', 'supervisor'].includes(user.perfil);
  }

  function showLogin(message = '') {
    $('authGate').style.display = 'flex';
    $('content').style.display = 'none';
    if (message) {
      $('loginError').textContent = message;
      $('loginError').style.display = 'block';
    }
  }

  function showContent(user) {
    $('authGate').style.display = 'none';
    $('content').style.display = 'block';
    $('currentUser').textContent = `${user.nome} · ${user.perfil === 'admin' ? 'administração' : 'supervisão'}`;
  }

  async function loadUsers() {
    try {
      const payload = await api('/api/users', {}, false);
      const users = (Array.isArray(payload.users) ? payload.users : []).filter(allowed);
      $('loginUser').innerHTML = users.length
        ? users.map(user => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.nome)} (${escapeHtml(user.perfil)})</option>`).join('')
        : '<option value="">Nenhum usuário gerencial disponível</option>';
    } catch (error) {
      $('loginUser').innerHTML = '<option value="">Servidor indisponível</option>';
      showLogin(error.message);
    }
  }

  function isoInput(date) {
    const value = new Date(date);
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }

  function syncPeriod() {
    const custom = $('period').value === 'custom';
    $('start').disabled = !custom;
    $('end').disabled = !custom;
    if (!custom) {
      const now = new Date();
      const days = $('period').value === 'today' ? 1 : Number($('period').value || 30);
      const start = new Date(now);
      start.setDate(start.getDate() - Math.max(0, days - 1));
      $('start').value = isoInput(start);
      $('end').value = isoInput(now);
    }
  }

  function fmtDate(value, withTime = true) {
    if (!value) return 'Sem data';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return withTime ? date.toLocaleString('pt-BR') : date.toLocaleDateString('pt-BR');
  }

  function requestPath() {
    const params = new URLSearchParams({
      mode: $('period').value,
      source: $('source').value,
      category: $('category').value
    });
    if ($('period').value === 'custom') {
      if ($('start').value) params.set('start', $('start').value);
      if ($('end').value) params.set('end', $('end').value);
    }
    if ($('query').value.trim()) params.set('q', $('query').value.trim());
    return '/api/audit/advanced?' + params.toString();
  }

  function renderSummary(summary = {}) {
    for (const id of ['total', 'operational', 'custody', 'access', 'occurrences', 'securityAlerts']) {
      $(id).textContent = Number(summary[id] || 0);
    }
    $('resultCount').textContent = `${Number(summary.total || 0)} ${Number(summary.total || 0) === 1 ? 'evento' : 'eventos'}`;
  }

  function renderIntegrity(integrity = {}) {
    const overall = integrity.overall || 'warning';
    const labels = { ok: 'Íntegra', warning: 'Atenção', error: 'Falha' };
    $('overallState').className = 'state ' + overall;
    $('overallState').textContent = labels[overall] || 'Atenção';
    $('overallText').textContent = overall === 'ok'
      ? 'Banco e cadeias verificados sem divergências.'
      : overall === 'error'
        ? 'Existe divergência de integridade que exige apuração.'
        : 'Existem registros históricos sem cadeia verificável.';
    $('databaseState').textContent = integrity.database === 'ok' ? 'Integridade interna: OK.' : `Resultado: ${integrity.database || 'não informado'}.`;
    const pkg = integrity.packageChains || {};
    $('packageState').textContent = `${Number(pkg.valid || 0)} íntegras de ${Number(pkg.total || 0)}. ${Number(pkg.invalid || 0)} falha(s), ${Number(pkg.missing || 0)} sem cadeia.`;
    const occurrence = integrity.occurrenceChains || {};
    $('occurrenceState').textContent = `${Number(occurrence.valid || 0)} íntegras de ${Number(occurrence.total || 0)}. ${Number(occurrence.invalid || 0)} falha(s).`;
  }

  function renderEvents(events) {
    const values = Array.isArray(events) ? events : [];
    $('eventBody').innerHTML = values.length ? values.map(event => {
      const security = event.category === 'security' ? '<span class="badge security">Segurança</span> ' : '';
      return `<tr><td>${escapeHtml(fmtDate(event.occurredAt))}</td><td>${security}<span class="badge ${escapeHtml(event.source)}">${escapeHtml(event.sourceLabel)}</span></td><td><div class="event-title">${escapeHtml(event.action)}</div><div class="minor">${escapeHtml(event.detail || '')}</div></td><td><strong>${escapeHtml(event.actor || 'Sistema')}</strong><div class="minor">${escapeHtml(event.actorRole || '')}</div></td><td>${escapeHtml(event.target || '')}</td><td>${escapeHtml(event.ip || '')}</td><td><div class="hash">${escapeHtml(event.hash || 'Registro protegido pelo banco')}</div></td></tr>`;
    }).join('') : '<tr><td colspan="7" class="empty">Nenhum evento encontrado no período e filtros informados.</td></tr>';
  }

  function render(report) {
    currentReport = report;
    $('associationName').textContent = report.association?.nome || 'Associação de Moradores';
    renderSummary(report.summary);
    renderIntegrity(report.integrity);
    renderEvents(report.events);
    const period = `${fmtDate(report.period?.start, false)} a ${fmtDate(report.period?.end, false)}`;
    $('updatedAt').textContent = `Período: ${period} · atualizado ${fmtDate(report.generatedAt)}`;
    $('printMeta').textContent = `Associação: ${report.association?.nome || ''} | Período: ${period} | Gerado em: ${fmtDate(report.generatedAt)}`;
    $('reportHash').textContent = `SHA-256 do resultado filtrado: ${report.reportHash || 'não informado'}`;
  }

  async function refresh() {
    $('applyButton').disabled = true;
    try {
      render(await api(requestPath()));
    } catch (error) {
      if (error.status === 403) {
        authToken = '';
        localStorage.removeItem('authToken');
        return showLogin('Sua sessão expirou ou não possui permissão.');
      }
      alert('Não foi possível carregar a auditoria: ' + error.message);
    } finally {
      $('applyButton').disabled = false;
    }
  }

  function csvCell(value) {
    const valueText = String(value == null ? '' : value).replace(/\r?\n/g, ' ');
    return '"' + valueText.replace(/"/g, '""') + '"';
  }

  function downloadCsv() {
    if (!currentReport) return;
    const lines = [];
    const row = values => lines.push(values.map(csvCell).join(';'));
    row(['PORTARIASYNC', 'RELATÓRIOS E AUDITORIA AVANÇADA']);
    row(['Associação', currentReport.association?.nome || '', 'Início', fmtDate(currentReport.period?.start), 'Fim', fmtDate(currentReport.period?.end)]);
    row(['SHA-256 do resultado', currentReport.reportHash || '']);
    row([]);
    row(['Data e hora', 'Fonte', 'Categoria', 'Ação', 'Responsável', 'Perfil', 'Referência', 'Detalhe', 'IP', 'Hash do evento']);
    for (const event of currentReport.events || []) {
      row([fmtDate(event.occurredAt), event.sourceLabel, event.category, event.action, event.actor, event.actorRole, event.target, event.detail, event.ip, event.hash || '']);
    }
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `portariasync-auditoria-${isoInput(new Date())}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function login() {
    $('loginError').style.display = 'none';
    $('loginButton').disabled = true;
    try {
      const payload = await api('/api/auth/login', {
        method: 'POST', body: JSON.stringify({ id: $('loginUser').value, senha: $('loginPassword').value })
      }, false);
      if (!allowed(payload.user)) throw new Error('Acesso restrito à administração e supervisão.');
      authToken = payload.token || '';
      localStorage.setItem('authToken', authToken);
      $('loginPassword').value = '';
      showContent(payload.user);
      await refresh();
    } catch (error) {
      showLogin(error.message);
    } finally {
      $('loginButton').disabled = false;
    }
  }

  async function verifySession() {
    if (!authToken) return false;
    try {
      const payload = await api('/api/auth/me');
      if (!allowed(payload.user)) return false;
      showContent(payload.user);
      await refresh();
      return true;
    } catch (_) {
      authToken = '';
      localStorage.removeItem('authToken');
      return false;
    }
  }

  async function logout() {
    try { if (authToken) await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
    authToken = '';
    currentReport = null;
    localStorage.removeItem('authToken');
    await loadUsers();
    showLogin('Sessão encerrada.');
  }

  async function boot() {
    $('period').addEventListener('change', syncPeriod);
    $('applyButton').addEventListener('click', refresh);
    $('query').addEventListener('keydown', event => { if (event.key === 'Enter') refresh(); });
    $('csvButton').addEventListener('click', downloadCsv);
    $('printButton').addEventListener('click', () => window.print());
    $('logoutButton').addEventListener('click', logout);
    $('loginButton').addEventListener('click', login);
    $('loginPassword').addEventListener('keydown', event => { if (event.key === 'Enter') login(); });
    syncPeriod();
    await loadUsers();
    if (!await verifySession()) showLogin();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
