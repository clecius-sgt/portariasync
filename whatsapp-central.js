(function () {
  'use strict';

  const API_BASE = localStorage.getItem('apiBaseUrl') || '';
  let authToken = localStorage.getItem('authToken') || '';
  let currentUser = null;
  let messages = [];
  let associations = [];
  let refreshTimer = null;

  const $ = id => document.getElementById(id);

  const STATUS_LABELS = {
    accepted: 'Aceita',
    sent: 'Enviada',
    received: 'Recebida',
    read: 'Lida',
    read_by_me: 'Lida',
    played: 'Reproduzida',
    failed: 'Falha'
  };

  const KIND_LABELS = {
    resident_otp: 'Código do Portal do Morador',
    withdrawal_authorization: 'Autorização de retirada',
    withdrawal_pin: 'PIN de retirada',
    resident_occurrence: 'Confirmação de ocorrência',
    package_reminder: 'Lembrete de encomenda',
    package_notice: 'Aviso de encomenda',
    test: 'Teste de WhatsApp',
    image: 'Imagem',
    text: 'Mensagem de texto'
  };

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

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatDate(value) {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('pt-BR');
  }

  function statusLabel(status) {
    return STATUS_LABELS[status] || String(status || '-');
  }

  function kindLabel(kind) {
    return KIND_LABELS[kind] || String(kind || 'Mensagem');
  }

  function associationLabel(item) {
    return String(item?.associationName || item?.associationId || 'Não identificada');
  }

  function showLogin(message) {
    $('authGate').style.display = 'flex';
    $('content').style.display = 'none';
    if (message) {
      $('loginError').textContent = message;
      $('loginError').style.display = 'block';
    }
  }

  function showPanel(user) {
    currentUser = user;
    $('authGate').style.display = 'none';
    $('content').style.display = 'block';
    $('adminUser').textContent = user?.nome ? user.nome + ' · plataforma' : 'Administrador da plataforma';
  }

  async function loadUsers() {
    const select = $('loginUser');
    try {
      const payload = await api('/api/users', {}, false);
      const users = (Array.isArray(payload.users) ? payload.users : [])
        .filter(user => user.perfil === 'admin' && user.plataforma === true);
      select.innerHTML = '';
      for (const user of users) {
        const option = document.createElement('option');
        option.value = user.id;
        option.textContent = user.nome;
        select.appendChild(option);
      }
      if (!users.length) select.innerHTML = '<option value="">Administrador da plataforma não localizado</option>';
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
      if (!payload.user || payload.user.perfil !== 'admin' || payload.user.plataforma !== true) return false;
      showPanel(payload.user);
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
    const id = $('loginUser').value;
    const senha = $('loginPassword').value;
    const button = $('loginButton');
    const errorBox = $('loginError');
    errorBox.style.display = 'none';
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
      if (!payload.user || payload.user.perfil !== 'admin' || payload.user.plataforma !== true) {
        throw new Error('Acesso restrito ao administrador da plataforma.');
      }
      authToken = payload.token || '';
      localStorage.setItem('authToken', authToken);
      $('loginPassword').value = '';
      showPanel(payload.user);
      await refresh();
      startAutoRefresh();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.style.display = 'block';
    } finally {
      button.disabled = false;
      button.textContent = 'Entrar na Central';
    }
  }

  function buildKindOptions() {
    const select = $('kindFilter');
    const current = select.value;
    const kinds = Array.from(new Set(messages.map(item => item.kind).filter(Boolean))).sort();
    select.innerHTML = '<option value="">Todos</option>';
    for (const kind of kinds) {
      const option = document.createElement('option');
      option.value = kind;
      option.textContent = kindLabel(kind);
      select.appendChild(option);
    }
    if (kinds.includes(current)) select.value = current;
  }

  function buildAssociationOptions() {
    const select = $('associationFilter');
    const current = select.value;
    const options = new Map();
    for (const association of associations) {
      if (association?.id) options.set(String(association.id), String(association.nome || association.id));
    }
    for (const item of messages) {
      const id = String(item?.associationId || '');
      if (id && !options.has(id)) options.set(id, associationLabel(item));
      if (!id) options.set('__unknown__', 'Não identificada');
    }
    select.innerHTML = '<option value="">Todas</option>';
    for (const [id, label] of Array.from(options.entries()).sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'))) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = label;
      select.appendChild(option);
    }
    if (options.has(current)) select.value = current;
  }

  function deriveFunnel(tracking) {
    if (tracking?.funnel) return tracking.funnel;
    const accepted = messages.filter(item => item.acceptedAt).length;
    const sent = messages.filter(item => item.sentAt || item.receivedAt || item.readAt || item.playedAt).length;
    const received = messages.filter(item => item.receivedAt || item.readAt || item.playedAt).length;
    const read = messages.filter(item => item.readAt || item.playedAt).length;
    const failed = messages.filter(item => item.failedAt || item.status === 'failed').length;
    return { accepted, sent, received, read, failed };
  }

  function renderSummary(tracking) {
    const total = Number(tracking?.total || 0);
    const funnel = deriveFunnel(tracking);
    $('countTotal').textContent = total;
    $('countAccepted').textContent = Number(funnel.accepted || 0);
    $('countSent').textContent = Number(funnel.sent || 0);
    $('countReceived').textContent = Number(funnel.received || 0);
    $('countRead').textContent = Number(funnel.read || 0);
    $('countFailed').textContent = Number(funnel.failed || 0);
    $('trackingStatus').textContent = total
      ? 'Último evento em ' + formatDate(tracking.lastUpdateAt) + '. Atualização automática a cada 15 segundos.'
      : 'Nenhuma mensagem monitorada até o momento. Atualização automática a cada 15 segundos.';
  }

  function filteredMessages() {
    const query = String($('searchInput').value || '').trim().toLowerCase();
    const association = $('associationFilter').value;
    const status = $('statusFilter').value;
    const kind = $('kindFilter').value;
    return messages.filter(item => {
      if (association) {
        const itemAssociation = String(item?.associationId || '') || '__unknown__';
        if (itemAssociation !== association) return false;
      }
      if (status) {
        const itemStatus = item.status === 'read_by_me' ? 'read' : item.status;
        if (itemStatus !== status) return false;
      }
      if (kind && item.kind !== kind) return false;
      if (!query) return true;
      const haystack = [
        item.phone,
        item.referenceId,
        item.kind,
        kindLabel(item.kind),
        item.status,
        statusLabel(item.status),
        item.associationId,
        associationLabel(item)
      ].map(value => String(value || '').toLowerCase()).join(' ');
      return haystack.includes(query);
    });
  }

  function renderRows() {
    const filtered = filteredMessages();
    const tbody = $('messageRows');
    $('resultCount').textContent = filtered.length + (filtered.length === 1 ? ' registro' : ' registros');
    $('emptyState').style.display = filtered.length ? 'none' : 'block';
    tbody.innerHTML = filtered.map(item => {
      const status = String(item.status || 'accepted');
      const receivedAt = item.receivedAt || (['read', 'read_by_me', 'played'].includes(status) ? item.updatedAt : null);
      const failure = item.error ? escapeHtml(item.error) : '-';
      return '<tr>' +
        '<td><span class="strong">' + escapeHtml(formatDate(item.updatedAt)) + '</span></td>' +
        '<td><span class="strong">' + escapeHtml(associationLabel(item)) + '</span></td>' +
        '<td>' + escapeHtml(kindLabel(item.kind)) + '</td>' +
        '<td>' + escapeHtml(item.referenceId || '-') + '</td>' +
        '<td><span class="strong">' + escapeHtml(item.phone || '-') + '</span></td>' +
        '<td><span class="badge ' + escapeHtml(status) + '">' + escapeHtml(statusLabel(status)) + '</span></td>' +
        '<td class="muted">' + escapeHtml(formatDate(item.acceptedAt)) + '</td>' +
        '<td class="muted">' + escapeHtml(formatDate(receivedAt)) + '</td>' +
        '<td class="muted">' + escapeHtml(formatDate(item.readAt)) + '</td>' +
        '<td class="muted">' + failure + '</td>' +
      '</tr>';
    }).join('');
  }

  async function refresh() {
    const button = $('refreshButton');
    if (button) {
      button.disabled = true;
      button.textContent = 'Atualizando...';
    }
    try {
      const payload = await api('/api/zapi/admin/recent?limit=200');
      messages = Array.isArray(payload.messages) ? payload.messages : [];
      associations = Array.isArray(payload.associations) ? payload.associations : [];
      renderSummary(payload.tracking || {});
      buildAssociationOptions();
      buildKindOptions();
      renderRows();
      $('lastRefresh').textContent = 'Atualizado em ' + new Date().toLocaleTimeString('pt-BR');
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        stopAutoRefresh();
        authToken = '';
        localStorage.removeItem('authToken');
        showLogin(error.message);
        await loadUsers();
        return;
      }
      $('trackingStatus').textContent = 'Falha ao atualizar: ' + error.message;
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = 'Atualizar';
      }
    }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(refresh, 15000);
  }

  function stopAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  async function logout() {
    stopAutoRefresh();
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
    authToken = '';
    currentUser = null;
    localStorage.removeItem('authToken');
    showLogin();
    await loadUsers();
  }

  $('loginButton').addEventListener('click', login);
  $('loginPassword').addEventListener('keydown', event => { if (event.key === 'Enter') login(); });
  $('refreshButton').addEventListener('click', refresh);
  $('logoutButton').addEventListener('click', logout);
  $('searchInput').addEventListener('input', renderRows);
  $('associationFilter').addEventListener('change', renderRows);
  $('statusFilter').addEventListener('change', renderRows);
  $('kindFilter').addEventListener('change', renderRows);
  $('clearFilters').addEventListener('click', () => {
    $('searchInput').value = '';
    $('associationFilter').value = '';
    $('statusFilter').value = '';
    $('kindFilter').value = '';
    renderRows();
  });

  (async () => {
    const valid = await verifyCurrentSession();
    if (!valid) {
      showLogin();
      await loadUsers();
    }
  })();
})();
