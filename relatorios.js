(function() {
  'use strict';

  const API_BASE = localStorage.getItem('apiBaseUrl') || '';
  let authToken = localStorage.getItem('authToken') || '';
  let currentUser = null;
  let currentReport = null;

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

  function allowed(user) {
    return !!user && ['admin', 'supervisor'].includes(user.perfil);
  }

  function showLogin(message) {
    $('authGate').style.display = 'flex';
    $('reportContent').style.display = 'none';
    if (message) {
      $('loginError').textContent = message;
      $('loginError').style.display = 'block';
    }
  }

  function showReport(user) {
    currentUser = user;
    $('authGate').style.display = 'none';
    $('reportContent').style.display = 'block';
    $('reportUser').textContent = user.nome + ' · ' + (user.perfil === 'admin' ? 'administração' : 'supervisão');
  }

  async function loadUsers() {
    const select = $('loginUser');
    try {
      const payload = await api('/api/users', {}, false);
      const users = (Array.isArray(payload.users) ? payload.users : []).filter(allowed);
      select.innerHTML = '';
      for (const user of users) {
        const option = document.createElement('option');
        option.value = user.id;
        option.textContent = user.nome + ' (' + user.perfil + ')';
        select.appendChild(option);
      }
      if (!users.length) select.innerHTML = '<option value="">Nenhum usuário gerencial disponível</option>';
    } catch (error) {
      select.innerHTML = '<option value="">Falha ao carregar usuários</option>';
      showLogin(error.message);
    }
  }

  async function verifySession() {
    if (!authToken) return false;
    try {
      const payload = await api('/api/auth/me');
      if (!allowed(payload.user)) return false;
      showReport(payload.user);
      await refreshReport();
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
      if (!allowed(payload.user)) throw new Error('Acesso restrito à administração e supervisão.');
      authToken = payload.token || '';
      localStorage.setItem('authToken', authToken);
      $('loginPassword').value = '';
      showReport(payload.user);
      await refreshReport();
    } catch (error) {
      showLogin(error.message);
    } finally {
      $('loginButton').disabled = false;
    }
  }

  function isoDateInput(date) {
    const d = new Date(date);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function syncPeriodInputs() {
    const mode = $('periodSelect').value;
    const custom = mode === 'custom';
    $('startDate').disabled = !custom;
    $('endDate').disabled = !custom;
    if (!custom) {
      const now = new Date();
      const period = ManagerialReports.resolvePeriod({ mode }, now);
      $('startDate').value = isoDateInput(period.start);
      $('endDate').value = isoDateInput(period.end);
    }
  }

  function periodOptions() {
    const mode = $('periodSelect').value;
    return {
      mode,
      start: $('startDate').value,
      end: $('endDate').value
    };
  }

  function fmtDate(value, includeTime = true) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return includeTime ? date.toLocaleString('pt-BR') : date.toLocaleDateString('pt-BR');
  }

  function fmtHours(value) {
    const hours = Number(value);
    if (!Number.isFinite(hours)) return '-';
    if (hours < 1) return Math.max(1, Math.round(hours * 60)) + ' min';
    if (hours < 24) return (Math.round(hours * 10) / 10).toLocaleString('pt-BR') + ' h';
    return (Math.round(hours / 24 * 10) / 10).toLocaleString('pt-BR') + ' d';
  }

  function pct(value) {
    return Number(value || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function renderBars(id, rows) {
    const container = $(id);
    const values = Array.isArray(rows) ? rows : [];
    if (!values.length || !values.some(row => row.count > 0)) {
      container.innerHTML = '<div class="empty">Sem dados no período selecionado.</div>';
      return;
    }
    const max = Math.max(...values.map(row => Number(row.count || 0)), 1);
    container.innerHTML = values.map(row => {
      const width = Math.max(2, Math.round(Number(row.count || 0) * 100 / max));
      return '<div class="bar-row"><div class="bar-label" title="' + escapeHtml(row.label) + '">' + escapeHtml(row.label) + '</div><div class="bar-track"><div class="bar-fill" style="width:' + width + '%"></div></div><div class="bar-value">' + Number(row.count || 0) + '</div></div>';
    }).join('');
  }

  function renderPending(rows) {
    const tbody = $('pendingTable');
    const list = Array.isArray(rows) ? rows : [];
    $('pendingCountPill').textContent = list.length + (list.length === 1 ? ' item' : ' itens');
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">Nenhuma encomenda pendente.</td></tr>';
      return;
    }
    tbody.innerHTML = list.slice(0, 30).map(row => '<tr>' +
      '<td>' + escapeHtml(fmtDate(row.entryAt)) + '</td>' +
      '<td><strong>' + escapeHtml(fmtHours(row.ageHours)) + '</strong></td>' +
      '<td>' + escapeHtml(row.resident) + '</td>' +
      '<td>' + escapeHtml(row.house) + '</td>' +
      '<td>' + escapeHtml(row.carrier) + '</td>' +
      '<td>' + escapeHtml(row.code || '-') + '</td>' +
      '</tr>').join('');
  }

  function renderWithdrawals(rows) {
    const tbody = $('withdrawalTable');
    const list = Array.isArray(rows) ? rows : [];
    $('withdrawalCountPill').textContent = list.length + (list.length === 1 ? ' item' : ' itens');
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">Nenhuma retirada no período.</td></tr>';
      return;
    }
    tbody.innerHTML = list.slice(0, 30).map(row => '<tr>' +
      '<td>' + escapeHtml(fmtDate(row.withdrawalAt)) + '</td>' +
      '<td>' + escapeHtml(fmtHours(row.pickupHours)) + '</td>' +
      '<td>' + escapeHtml(row.resident) + '</td>' +
      '<td>' + escapeHtml(row.house) + '</td>' +
      '<td>' + escapeHtml(row.carrier) + '</td>' +
      '<td>' + escapeHtml(row.code || '-') + '</td>' +
      '</tr>').join('');
  }

  function renderReport(report, state) {
    currentReport = report;
    const t = report.totals;
    $('kpiReceived').textContent = t.received;
    $('kpiWithdrawn').textContent = t.withdrawn;
    $('kpiPending').textContent = t.pending;
    $('kpiAvgPickup').textContent = fmtHours(t.avgPickupHours);
    $('kpiSameDay').textContent = pct(t.sameDayRate);
    $('kpiMedian').textContent = fmtHours(t.medianPickupHours);
    $('kpiOver48').textContent = t.pendingOver48h;
    $('pendingDesc').textContent = t.pendingOver48h ? t.pendingOver48h + ' com 48h ou mais' : 'aguardando retirada';
    $('pickupDesc').textContent = t.withdrawn ? 'calculado sobre ' + t.withdrawn + ' retirada(s)' : 'sem retiradas com datas válidas';

    $('kpiOcr').textContent = report.ocr.total;
    $('ocrDesc').textContent = report.ocr.total ? pct(report.ocr.addressRate) + ' com endereço reconhecido' : 'leituras técnicas contabilizadas';
    $('ocrTotal').textContent = report.ocr.total;
    $('ocrAddress').textContent = pct(report.ocr.addressRate);
    $('ocrFallback').textContent = pct(report.ocr.fallbackRate);
    $('ocrFailure').textContent = pct(report.ocr.failureRate);
    $('ocrTime').textContent = Number.isFinite(report.ocr.avgElapsedMs) ? (report.ocr.avgElapsedMs / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' s' : '-';

    renderBars('carrierBars', report.carriers);
    renderBars('residentBars', report.residents);
    renderBars('agingBars', report.pendingAging);
    renderPending(report.pendingRows);
    renderWithdrawals(report.withdrawals);

    const periodLabel = fmtDate(report.period.start, false) + ' a ' + fmtDate(report.period.end, false);
    $('updatedAt').textContent = 'Período: ' + periodLabel + ' · atualizado ' + new Date().toLocaleString('pt-BR');
    $('printMeta').textContent = 'Período: ' + periodLabel + ' | Gerado em ' + fmtDate(report.generatedAt) + ' | Base: ' + (state.storage || 'sqlite');
  }

  async function refreshReport() {
    if (!authToken) return showLogin('Sessão não encontrada.');
    $('applyButton').disabled = true;
    try {
      const state = await api('/api/app-state');
      const report = ManagerialReports.build(state || {}, periodOptions(), new Date());
      renderReport(report, state || {});
    } catch (error) {
      if (error.status === 403) {
        authToken = '';
        localStorage.removeItem('authToken');
        return showLogin('Sua sessão expirou ou não possui permissão.');
      }
      alert('Não foi possível gerar o relatório: ' + error.message);
    } finally {
      $('applyButton').disabled = false;
    }
  }

  function csvCell(value) {
    const text = String(value == null ? '' : value).replace(/\r?\n/g, ' ');
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function downloadCsv() {
    if (!currentReport) return;
    const r = currentReport;
    const lines = [];
    const row = values => lines.push(values.map(csvCell).join(';'));
    row(['PORTARIASYNC - RELATÓRIO GERENCIAL']);
    row(['Período inicial', fmtDate(r.period.start), 'Período final', fmtDate(r.period.end), 'Gerado em', fmtDate(r.generatedAt)]);
    row([]);
    row(['INDICADOR', 'VALOR']);
    row(['Encomendas recebidas', r.totals.received]);
    row(['Retiradas', r.totals.withdrawn]);
    row(['Pendentes atuais', r.totals.pending]);
    row(['Pendentes 48h+', r.totals.pendingOver48h]);
    row(['Tempo médio de retirada (h)', Number.isFinite(r.totals.avgPickupHours) ? r.totals.avgPickupHours.toFixed(2) : '']);
    row(['Mediana de retirada (h)', Number.isFinite(r.totals.medianPickupHours) ? r.totals.medianPickupHours.toFixed(2) : '']);
    row(['Retirada até 24h (%)', r.totals.sameDayRate]);
    row([]);
    row(['TRANSPORTADORAS', 'ENCOMENDAS']);
    r.carriers.forEach(item => row([item.label, item.count]));
    row([]);
    row(['PENDÊNCIAS', 'TEMPO (H)', 'MORADOR', 'ENDEREÇO', 'TRANSPORTADORA', 'CÓDIGO']);
    r.pendingRows.forEach(item => row([fmtDate(item.entryAt), Number.isFinite(item.ageHours) ? item.ageHours.toFixed(2) : '', item.resident, item.house, item.carrier, item.code]));
    row([]);
    row(['RETIRADA', 'TEMPO (H)', 'MORADOR', 'ENDEREÇO', 'TRANSPORTADORA', 'CÓDIGO']);
    r.withdrawals.forEach(item => row([fmtDate(item.withdrawalAt), Number.isFinite(item.pickupHours) ? item.pickupHours.toFixed(2) : '', item.resident, item.house, item.carrier, item.code]));

    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'portariasync-relatorio-' + isoDateInput(new Date()) + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function logout() {
    try { if (authToken) await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
    authToken = '';
    currentUser = null;
    currentReport = null;
    localStorage.removeItem('authToken');
    await loadUsers();
    showLogin('Sessão encerrada.');
  }

  async function boot() {
    $('periodSelect').addEventListener('change', syncPeriodInputs);
    $('applyButton').addEventListener('click', refreshReport);
    $('csvButton').addEventListener('click', downloadCsv);
    $('printButton').addEventListener('click', () => window.print());
    $('logoutButton').addEventListener('click', logout);
    $('loginButton').addEventListener('click', login);
    $('loginPassword').addEventListener('keydown', event => { if (event.key === 'Enter') login(); });
    syncPeriodInputs();
    await loadUsers();
    const ok = await verifySession();
    if (!ok) showLogin();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
