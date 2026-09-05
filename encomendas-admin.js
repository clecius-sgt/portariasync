(() => {
  'use strict';

  const API_BASE = localStorage.getItem('apiBaseUrl') || '';
  const $ = id => document.getElementById(id);
  let authToken = localStorage.getItem('authToken') || '';
  let currentUser = null;
  let packages = [];
  let residents = [];
  let currentVersion = 0;
  let refreshTimer = null;

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
      error.code = payload.code || '';
      throw error;
    }
    return payload;
  }

  function toast(message, error = false) {
    const node = $('toast');
    node.textContent = message;
    node.className = 'toast' + (error ? ' error' : '');
    node.style.display = 'block';
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { node.style.display = 'none'; }, 4200);
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
    currentUser = user;
    $('authGate').style.display = 'none';
    $('content').style.display = 'block';
    $('currentUser').textContent = `${user.nome} · ${user.perfil}`;
    $('adminLink').style.display = user.perfil === 'admin' ? '' : 'none';
    $('permissionHint').textContent = user.perfil === 'admin'
      ? 'Pode corrigir, cancelar e reabrir registros.'
      : user.perfil === 'supervisor'
        ? 'Pode consultar e corrigir registros pendentes.'
        : 'Consulta liberada. Alterações dependem da supervisão ou administração.';
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

  function parseDate(value) {
    if (!value) return null;
    const raw = String(value).trim();
    const br = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (br) return new Date(Number(br[3]), Number(br[2]) - 1, Number(br[1]), Number(br[4] || 0), Number(br[5] || 0), Number(br[6] || 0));
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatDate(value) {
    const date = parseDate(value);
    return date ? date.toLocaleString('pt-BR') : 'Sem data';
  }

  function formatAge(value) {
    const hours = Number(value);
    if (!Number.isFinite(hours)) return 'Encerrada';
    if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
    if (hours < 24) return `${Math.floor(hours)}h`;
    const days = Math.floor(hours / 24);
    const rest = Math.floor(hours % 24);
    return rest ? `${days}d ${rest}h` : `${days}d`;
  }

  function statusInfo(item) {
    if (item.status === 'retirado') return ['Retirada', 'withdrawn'];
    if (item.status === 'cancelado') return ['Cancelada', 'cancelled'];
    const labels = { critical: 'Crítica', priority: 'Prioritária', attention: 'Atenção', normal: 'Aguardando' };
    return [labels[item.level] || 'Aguardando', item.level || 'pending'];
  }

  function renderSummary(summary = {}) {
    for (const id of ['total', 'pending', 'withdrawn', 'cancelled', 'priority', 'critical']) {
      $(id).textContent = Number(summary[id] || 0);
    }
    $('resultCount').textContent = `${Number(summary.filtered || 0)} ${Number(summary.filtered || 0) === 1 ? 'registro' : 'registros'}`;
  }

  function renderRows() {
    const canEdit = ['admin', 'supervisor'].includes(currentUser?.perfil);
    const isAdmin = currentUser?.perfil === 'admin';
    $('packageBody').innerHTML = packages.length ? packages.map(item => {
      const [label, badge] = statusInfo(item);
      const integrity = item.custody?.ok
        ? `<span class="badge withdrawn">Íntegra · ${Number(item.custody.eventCount || 0)} eventos</span>`
        : '<span class="badge cancelled">Verificação necessária</span>';
      const actions = [
        `<button class="btn soft" data-history="${escapeHtml(item.id)}">Histórico</button>`,
        item.status === 'pendente' && canEdit ? `<button class="btn primary" data-edit="${escapeHtml(item.id)}">Corrigir</button>` : '',
        item.status === 'pendente' && isAdmin ? `<button class="btn danger" data-cancel="${escapeHtml(item.id)}">Cancelar</button>` : '',
        item.status === 'cancelado' && isAdmin ? `<button class="btn primary" data-reopen="${escapeHtml(item.id)}">Reabrir</button>` : ''
      ].filter(Boolean).join('');
      return `<tr><td><span class="badge ${escapeHtml(badge)}">${escapeHtml(label)}</span>${item.status === 'cancelado' && item.cancellationReason ? `<div class="minor">${escapeHtml(item.cancellationReason)}</div>` : ''}</td><td>${escapeHtml(formatDate(item.entryAt))}</td><td><span class="name">${escapeHtml(item.code || 'Sem código')}</span></td><td><span class="name">${escapeHtml(item.residentName || 'Não informado')}</span><div class="minor">${escapeHtml(item.residentHouse || 'Sem endereço')}</div></td><td>${escapeHtml(item.carrier || 'Não informada')}</td><td>${escapeHtml(formatAge(item.ageHours))}</td><td>${integrity}</td><td><div class="actions">${actions}</div></td></tr>`;
    }).join('') : '<tr><td colspan="8" class="empty">Nenhuma encomenda encontrada com os filtros informados.</td></tr>';
  }

  function queryString() {
    const params = new URLSearchParams();
    const q = $('query').value.trim();
    if (q) params.set('q', q);
    params.set('status', $('status').value || 'todos');
    if ($('from').value) params.set('from', $('from').value);
    if ($('to').value) params.set('to', $('to').value);
    params.set('tzOffset', String(-new Date().getTimezoneOffset()));
    return params.toString();
  }

  async function loadPackages(silent = false) {
    $('refreshButton').disabled = true;
    try {
      const payload = await api('/api/packages/management?' + queryString());
      packages = Array.isArray(payload.packages) ? payload.packages : [];
      residents = Array.isArray(payload.residents) ? payload.residents : [];
      currentVersion = Number(payload.version || 0);
      $('associationName').textContent = payload.association?.nome || 'Associação de Moradores';
      $('updatedAt').textContent = `Atualizado em ${new Date().toLocaleString('pt-BR')}`;
      renderSummary(payload.summary);
      renderRows();
    } catch (error) {
      if (error.status === 403) {
        authToken = '';
        localStorage.removeItem('authToken');
        stopAutoRefresh();
        return showLogin('Sua sessão expirou ou não possui permissão.');
      }
      $('updatedAt').textContent = 'Falha na atualização: ' + error.message;
      if (!silent) toast(error.message, true);
    } finally {
      $('refreshButton').disabled = false;
    }
  }

  function openOverlay(id) { $(id).style.display = 'flex'; }
  function closeOverlay(id) { $(id).style.display = 'none'; }

  function openEdit(id) {
    const item = packages.find(value => value.id === id);
    if (!item) return;
    $('editId').value = item.id;
    $('editCode').value = item.code || '';
    $('editCarrier').value = item.carrier || '';
    $('editNotes').value = item.notes || '';
    $('editReason').value = '';
    $('editResident').innerHTML = residents.map(resident => `<option value="${escapeHtml(resident.id)}" ${resident.id === item.residentId ? 'selected' : ''}>${escapeHtml(resident.name)} · ${escapeHtml(resident.house)}</option>`).join('');
    openOverlay('editOverlay');
  }

  async function saveEdit(event) {
    event.preventDefault();
    const id = $('editId').value;
    $('saveButton').disabled = true;
    try {
      await api('/api/packages/management/' + encodeURIComponent(id), {
        method: 'PATCH',
        body: JSON.stringify({
          expectedVersion: currentVersion,
          code: $('editCode').value,
          carrier: $('editCarrier').value,
          residentId: $('editResident').value,
          notes: $('editNotes').value,
          reason: $('editReason').value
        })
      });
      closeOverlay('editOverlay');
      toast('Encomenda corrigida e alteração registrada no histórico.');
      await loadPackages(true);
    } catch (error) {
      toast(error.message, true);
      if (error.code === 'STATE_CHANGED') await loadPackages(true);
    } finally {
      $('saveButton').disabled = false;
    }
  }

  async function cancelPackage(id) {
    const reason = window.prompt('Informe o motivo do cancelamento:');
    if (reason == null) return;
    try {
      await api('/api/packages/management/' + encodeURIComponent(id) + '/cancel', {
        method: 'POST', body: JSON.stringify({ reason, expectedVersion: currentVersion })
      });
      toast('Encomenda cancelada sem excluir o histórico.');
      await loadPackages(true);
    } catch (error) {
      toast(error.message, true);
      if (error.code === 'STATE_CHANGED') await loadPackages(true);
    }
  }

  async function reopenPackage(id) {
    const reason = window.prompt('Informe o motivo da reabertura:');
    if (reason == null) return;
    try {
      await api('/api/packages/management/' + encodeURIComponent(id) + '/reopen', {
        method: 'POST', body: JSON.stringify({ reason, expectedVersion: currentVersion })
      });
      toast('Encomenda reaberta e devolvida à fila de retirada.');
      await loadPackages(true);
    } catch (error) {
      toast(error.message, true);
      if (error.code === 'STATE_CHANGED') await loadPackages(true);
    }
  }

  async function showHistory(id) {
    try {
      const payload = await api('/api/packages/management/' + encodeURIComponent(id));
      const item = payload.package || {};
      $('historyTitle').textContent = `Histórico · ${item.code || 'Encomenda'}`;
      $('integrity').className = 'integrity' + (item.custody?.ok ? '' : ' bad');
      $('integrity').textContent = item.custody?.ok
        ? `Cadeia íntegra. ${Number(item.custody.eventCount || 0)} evento(s) encadeado(s) por SHA-256.`
        : `Falha de integridade: ${item.custody?.reason || 'verificação necessária'}.`;
      const timeline = Array.isArray(item.timeline) ? item.timeline : [];
      $('timeline').innerHTML = timeline.length ? timeline.slice().reverse().map(event => `<div class="event"><strong>${escapeHtml(event.seq)}. ${escapeHtml(event.title || event.type)}</strong><span>${escapeHtml(formatDate(event.occurredAt))} · ${escapeHtml(event.actor || 'PortalSync')} (${escapeHtml(event.actorRole || 'sistema')})</span><span>${escapeHtml(event.description || '')}</span><div class="hash">SHA-256: ${escapeHtml(event.hash || 'não informado')}</div></div>`).join('') : '<div class="empty">Nenhum evento registrado.</div>';
      openOverlay('historyOverlay');
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function login() {
    $('loginError').style.display = 'none';
    $('loginButton').disabled = true;
    try {
      const payload = await api('/api/auth/login', {
        method: 'POST', body: JSON.stringify({ id: $('loginUser').value, senha: $('loginPassword').value })
      }, false);
      authToken = payload.token || '';
      localStorage.setItem('authToken', authToken);
      $('loginPassword').value = '';
      showContent(payload.user);
      await loadPackages();
      startAutoRefresh();
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
      showContent(payload.user);
      await loadPackages();
      startAutoRefresh();
      return true;
    } catch (_) {
      authToken = '';
      localStorage.removeItem('authToken');
      return false;
    }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(() => { if (!document.hidden) loadPackages(true); }, 30000);
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
    await loadUsers();
    showLogin('Sessão encerrada.');
  }

  async function boot() {
    $('loginButton').addEventListener('click', login);
    $('loginPassword').addEventListener('keydown', event => { if (event.key === 'Enter') login(); });
    $('refreshButton').addEventListener('click', () => loadPackages());
    $('applyButton').addEventListener('click', () => loadPackages());
    $('clearButton').addEventListener('click', () => {
      $('query').value = ''; $('status').value = 'todos'; $('from').value = ''; $('to').value = ''; loadPackages();
    });
    $('query').addEventListener('keydown', event => { if (event.key === 'Enter') loadPackages(); });
    $('logoutButton').addEventListener('click', logout);
    $('editForm').addEventListener('submit', saveEdit);
    document.addEventListener('click', event => {
      const close = event.target.closest('[data-close]');
      if (close) closeOverlay(close.dataset.close);
      const history = event.target.closest('[data-history]');
      if (history) showHistory(history.dataset.history);
      const edit = event.target.closest('[data-edit]');
      if (edit) openEdit(edit.dataset.edit);
      const cancel = event.target.closest('[data-cancel]');
      if (cancel) cancelPackage(cancel.dataset.cancel);
      const reopen = event.target.closest('[data-reopen]');
      if (reopen) reopenPackage(reopen.dataset.reopen);
    });
    await loadUsers();
    if (!await verifySession()) showLogin();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
