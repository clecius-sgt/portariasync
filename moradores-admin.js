(function () {
  'use strict';

  const API_BASE = localStorage.getItem('apiBaseUrl') || '';
  let authToken = localStorage.getItem('authToken') || '';
  let currentUser = null;
  let residents = [];
  let editingId = '';
  let importRows = [];
  let importPreview = null;

  const $ = id => document.getElementById(id);

  async function api(path, options = {}, requireAuth = true) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (requireAuth && authToken) headers.Authorization = 'Bearer ' + authToken;
    const response = await fetch(API_BASE + path, { ...options, headers });
    let payload = {};
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) {
      const error = new Error(payload.error || ('Erro HTTP ' + response.status));
      error.status = response.status;
      error.payload = payload;
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

  function digits(value) { return String(value || '').replace(/\D/g, ''); }

  function formatPhone(value) {
    let raw = digits(value);
    if (raw.startsWith('55') && (raw.length === 12 || raw.length === 13)) raw = raw.slice(2);
    if (raw.length === 11) return '(' + raw.slice(0, 2) + ') ' + raw.slice(2, 7) + '-' + raw.slice(7);
    if (raw.length === 10) return '(' + raw.slice(0, 2) + ') ' + raw.slice(2, 6) + '-' + raw.slice(6);
    return raw || 'Sem WhatsApp';
  }

  function phoneInputMask(value) {
    const raw = digits(value).slice(0, 11);
    if (raw.length <= 2) return raw ? '(' + raw : '';
    if (raw.length <= 6) return '(' + raw.slice(0, 2) + ') ' + raw.slice(2);
    if (raw.length <= 10) return '(' + raw.slice(0, 2) + ') ' + raw.slice(2, 6) + '-' + raw.slice(6);
    return '(' + raw.slice(0, 2) + ') ' + raw.slice(2, 7) + '-' + raw.slice(7);
  }

  function formatDate(value) {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('pt-BR');
  }

  function toast(message) {
    const box = $('toast');
    box.textContent = message;
    box.style.display = 'block';
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { box.style.display = 'none'; }, 4200);
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
    $('adminUser').textContent = user?.nome ? user.nome + ' · administrador' : 'Administrador';
  }

  async function loadUsers() {
    const select = $('loginUser');
    try {
      const payload = await api('/api/users', {}, false);
      const users = (Array.isArray(payload.users) ? payload.users : []).filter(user => user.perfil === 'admin');
      select.innerHTML = '';
      for (const user of users) {
        const option = document.createElement('option');
        option.value = user.id;
        option.textContent = user.nome + (user.associacaoNome ? ' · ' + user.associacaoNome : '');
        select.appendChild(option);
      }
      if (!users.length) select.innerHTML = '<option value="">Nenhum administrador encontrado</option>';
    } catch (error) {
      select.innerHTML = '<option value="">Falha ao carregar usuários</option>';
      $('loginError').textContent = error.message;
      $('loginError').style.display = 'block';
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
    try {
      const payload = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ id, senha }) }, false);
      if (!payload.user || payload.user.perfil !== 'admin') throw new Error('Acesso restrito ao administrador.');
      authToken = payload.token || '';
      localStorage.setItem('authToken', authToken);
      $('loginPassword').value = '';
      showPanel(payload.user);
      await refresh();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.style.display = 'block';
    } finally {
      button.disabled = false;
    }
  }

  async function verifySession() {
    if (!authToken) return false;
    try {
      const payload = await api('/api/auth/me');
      if (!payload.user || payload.user.perfil !== 'admin') return false;
      showPanel(payload.user);
      await refresh();
      return true;
    } catch (_) {
      authToken = '';
      localStorage.removeItem('authToken');
      return false;
    }
  }

  function renderSummary(summary = {}) {
    $('countActive').textContent = Number(summary.active || 0);
    $('countInactive').textContent = Number(summary.inactive || 0);
    $('countNoPhone').textContent = Number(summary.withoutWhatsapp || 0);
    $('countDuplicates').textContent = Number(summary.exactDuplicates || 0);
    $('countSharedPhones').textContent = Number(summary.sharedPhones || 0);
  }

  function filteredResidents() {
    const status = $('statusFilter').value;
    const q = String($('searchInput').value || '').trim().toLowerCase();
    const qDigits = digits(q);
    return residents.filter(item => {
      if (status === 'active' && item.ativo === false) return false;
      if (status === 'inactive' && item.ativo !== false) return false;
      if (!q) return true;
      const haystack = [item.nome, item.casa, item.tipo, item.whats, formatPhone(item.whats)]
        .map(value => String(value || '').toLowerCase()).join(' ');
      return haystack.includes(q) || (qDigits && digits(item.whats).includes(qDigits));
    }).sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
  }

  function renderRows() {
    const items = filteredResidents();
    $('resultCount').textContent = items.length + (items.length === 1 ? ' registro' : ' registros');
    $('emptyState').style.display = items.length ? 'none' : 'block';
    $('residentRows').innerHTML = items.map(item => {
      const active = item.ativo !== false;
      const actions = active
        ? '<button class="btn-muted" data-action="edit" data-id="' + escapeHtml(item.id) + '">Editar</button><button class="btn-danger" data-action="deactivate" data-id="' + escapeHtml(item.id) + '">Desativar</button>'
        : '<button class="btn-gold" data-action="reactivate" data-id="' + escapeHtml(item.id) + '">Reativar</button>';
      return '<tr>' +
        '<td><span class="strong">' + escapeHtml(item.nome) + '</span></td>' +
        '<td>' + escapeHtml(item.casa) + '</td>' +
        '<td class="' + (item.whats ? '' : 'muted') + '">' + escapeHtml(formatPhone(item.whats)) + '</td>' +
        '<td>' + escapeHtml(item.tipo || '-') + '</td>' +
        '<td><span class="badge ' + (active ? 'active' : 'inactive') + '">' + (active ? 'Ativo' : 'Inativo') + '</span></td>' +
        '<td class="muted">' + escapeHtml(formatDate(item.cadastroAtualizadoEm || item.desativadoEm)) + '</td>' +
        '<td><div class="actions">' + actions + '</div></td>' +
      '</tr>';
    }).join('');
  }

  async function refresh() {
    const button = $('refreshButton');
    button.disabled = true;
    try {
      const payload = await api('/api/residents');
      residents = Array.isArray(payload.residents) ? payload.residents : [];
      $('associationName').textContent = payload.association?.nome || currentUser?.associacaoNome || 'Associação';
      renderSummary(payload.summary || {});
      renderRows();
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        authToken = '';
        localStorage.removeItem('authToken');
        showLogin(error.message);
        await loadUsers();
      } else {
        toast('Falha ao atualizar: ' + error.message);
      }
    } finally {
      button.disabled = false;
    }
  }

  function resetForm() {
    editingId = '';
    $('formTitle').textContent = 'Novo morador';
    $('residentName').value = '';
    $('residentAddress').value = '';
    $('residentPhone').value = '';
    $('residentType').value = '';
    $('formWarning').style.display = 'none';
    $('formWarning').textContent = '';
  }

  function editResident(id) {
    const item = residents.find(row => row.id === id && row.ativo !== false);
    if (!item) return;
    editingId = id;
    $('formTitle').textContent = 'Editar morador';
    $('residentName').value = item.nome || '';
    $('residentAddress').value = item.casa || '';
    $('residentPhone').value = formatPhone(item.whats).replace('Sem WhatsApp', '');
    $('residentType').value = item.tipo || '';
    $('formWarning').style.display = 'none';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function formPayload(allowSharedPhone) {
    return {
      nome: $('residentName').value,
      casa: $('residentAddress').value,
      whats: digits($('residentPhone').value),
      tipo: $('residentType').value,
      allowSharedPhone: allowSharedPhone === true
    };
  }

  async function saveResident(allowSharedPhone = false) {
    const button = $('saveResident');
    button.disabled = true;
    try {
      const path = editingId ? '/api/residents/' + encodeURIComponent(editingId) : '/api/residents';
      const method = editingId ? 'PUT' : 'POST';
      await api(path, { method, body: JSON.stringify(formPayload(allowSharedPhone)) });
      toast(editingId ? 'Morador atualizado.' : 'Morador cadastrado.');
      resetForm();
      await refresh();
    } catch (error) {
      if (error.payload?.code === 'SHARED_PHONE' && !allowSharedPhone) {
        const names = (error.payload.duplicates || []).map(item => item.nome + ' · ' + item.casa).join('\n');
        if (confirm(error.message + '\n\nCadastro(s):\n' + names + '\n\nConfirmar o compartilhamento deste WhatsApp?')) {
          return saveResident(true);
        }
      }
      $('formWarning').textContent = error.message;
      $('formWarning').style.display = 'block';
    } finally {
      button.disabled = false;
    }
  }

  async function deactivateResident(id) {
    const item = residents.find(row => row.id === id);
    if (!item) return;
    const reason = prompt('Motivo da desativação de ' + item.nome + ':', 'Mudança de morador');
    if (reason === null) return;
    try {
      await api('/api/residents/' + encodeURIComponent(id) + '/deactivate', { method: 'POST', body: JSON.stringify({ reason }) });
      toast('Morador desativado e preservado no histórico.');
      if (editingId === id) resetForm();
      await refresh();
    } catch (error) {
      let message = error.message;
      if (error.payload?.pendingPackages?.length) message += '\nPendências: ' + error.payload.pendingPackages.map(p => p.codigo || p.id).join(', ');
      alert(message);
    }
  }

  async function reactivateResident(id, allowSharedPhone = false) {
    try {
      await api('/api/residents/' + encodeURIComponent(id) + '/reactivate', { method: 'POST', body: JSON.stringify({ allowSharedPhone }) });
      toast('Morador reativado.');
      await refresh();
    } catch (error) {
      if (error.payload?.code === 'SHARED_PHONE' && !allowSharedPhone) {
        if (confirm(error.message + '\n\nDeseja reativar mantendo o número compartilhado?')) return reactivateResident(id, true);
      }
      alert(error.message);
    }
  }

  function parseDelimitedLine(line, delimiter) {
    const cells = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (quoted && line[i + 1] === '"') { current += '"'; i++; }
        else quoted = !quoted;
      } else if (char === delimiter && !quoted) {
        cells.push(current.trim()); current = '';
      } else current += char;
    }
    cells.push(current.trim());
    return cells;
  }

  function rowsFromText(text) {
    const source = String(text || '').trim();
    if (!source) throw new Error('Informe os dados ou selecione um arquivo.');
    if (source.startsWith('[') || source.startsWith('{')) {
      const parsed = JSON.parse(source);
      const rows = Array.isArray(parsed) ? parsed : parsed.moradores;
      if (!Array.isArray(rows)) throw new Error('JSON deve conter uma lista de moradores.');
      return rows;
    }
    const lines = source.split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 2) throw new Error('CSV deve possuir cabeçalho e ao menos um registro.');
    const delimiter = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
    const headers = parseDelimitedLine(lines[0], delimiter).map(value => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, ''));
    const mapHeader = name => headers.findIndex(h => name.includes(h));
    const idxName = headers.findIndex(h => ['nome','morador','name'].includes(h));
    const idxHouse = headers.findIndex(h => ['casa','endereco','unidade','address'].includes(h));
    const idxPhone = headers.findIndex(h => ['whats','whatsapp','telefone','phone'].includes(h));
    const idxType = headers.findIndex(h => ['tipo','type','observacao'].includes(h));
    if (idxName < 0 || idxHouse < 0) throw new Error('CSV precisa das colunas nome e casa/endereço.');
    return lines.slice(1).map(line => {
      const cells = parseDelimitedLine(line, delimiter);
      return { nome: cells[idxName] || '', casa: cells[idxHouse] || '', whats: idxPhone >= 0 ? cells[idxPhone] || '' : '', tipo: idxType >= 0 ? cells[idxType] || '' : '' };
    });
  }

  async function sourceImportRows() {
    const file = $('importFile').files?.[0];
    if (file) return rowsFromText(await file.text());
    return rowsFromText($('importText').value);
  }

  function renderImportPreview(preview) {
    importPreview = preview;
    const summary = preview?.summary || {};
    $('prevSource').textContent = summary.source || 0;
    $('prevAdd').textContent = summary.add || 0;
    $('prevUpdate').textContent = summary.update || 0;
    $('prevUnchanged').textContent = summary.unchanged || 0;
    $('prevConflict').textContent = summary.conflicts || 0;
    $('prevInvalid').textContent = summary.invalid || 0;
    const issues = (preview?.rows || []).filter(row => row.action === 'conflict' || row.action === 'invalid').slice(0, 12);
    $('importIssues').innerHTML = issues.length
      ? '<strong>Itens que exigem revisão:</strong><br>' + issues.map(row => 'Linha ' + (row.index + 2) + ': ' + escapeHtml(row.reason || row.error || 'Conflito')).join('<br>')
      : 'Prévia sem conflitos. A importação pode ser confirmada.';
    $('importPreview').style.display = 'block';
    $('applyImport').disabled = Number(summary.conflicts || 0) > 0 || Number(summary.invalid || 0) > 0 || Number(summary.applicable || 0) === 0;
  }

  async function previewImportData() {
    try {
      importRows = await sourceImportRows();
      const payload = await api('/api/residents/import/preview', {
        method: 'POST',
        body: JSON.stringify({ rows: importRows, allowSharedPhone: $('allowSharedPhoneImport').checked })
      });
      renderImportPreview(payload.preview);
    } catch (error) {
      alert('Não foi possível gerar a prévia: ' + error.message);
    }
  }

  async function applyImportData() {
    if (!importRows.length || !importPreview) return;
    const summary = importPreview.summary || {};
    const message = 'Confirmar importação?\n\nAdicionar: ' + (summary.add || 0) + '\nAtualizar: ' + (summary.update || 0) + '\nSem alteração: ' + (summary.unchanged || 0);
    if (!confirm(message)) return;
    const button = $('applyImport');
    button.disabled = true;
    try {
      const result = await api('/api/residents/import', {
        method: 'POST',
        body: JSON.stringify({ rows: importRows, allowSharedPhone: $('allowSharedPhoneImport').checked, confirm: true })
      });
      toast('Importação concluída: ' + result.added + ' adicionados, ' + result.updated + ' atualizados.');
      $('importFile').value = '';
      $('importText').value = '';
      $('importPreview').style.display = 'none';
      importRows = [];
      importPreview = null;
      await refresh();
    } catch (error) {
      alert(error.message);
      if (error.payload?.preview) renderImportPreview(error.payload.preview);
    } finally {
      button.disabled = false;
    }
  }

  function downloadTemplate() {
    const content = '\ufeffnome;casa;whats;tipo\nMaria da Silva;Rua Brasil, 100;11999999999;proprietário\n';
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'modelo-moradores-portariasync.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function logout() {
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
  $('statusFilter').addEventListener('change', renderRows);
  $('clearFilters').addEventListener('click', () => { $('searchInput').value = ''; $('statusFilter').value = 'active'; renderRows(); });
  $('newResident').addEventListener('click', resetForm);
  $('cancelEdit').addEventListener('click', resetForm);
  $('saveResident').addEventListener('click', () => saveResident(false));
  $('residentPhone').addEventListener('input', event => { event.target.value = phoneInputMask(event.target.value); });
  $('residentRows').addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const id = button.dataset.id;
    if (button.dataset.action === 'edit') editResident(id);
    if (button.dataset.action === 'deactivate') deactivateResident(id);
    if (button.dataset.action === 'reactivate') reactivateResident(id, false);
  });
  $('previewImport').addEventListener('click', previewImportData);
  $('applyImport').addEventListener('click', applyImportData);
  $('downloadTemplate').addEventListener('click', downloadTemplate);
  $('importFile').addEventListener('change', () => { importPreview = null; importRows = []; $('importPreview').style.display = 'none'; $('applyImport').disabled = true; });
  $('importText').addEventListener('input', () => { importPreview = null; importRows = []; $('importPreview').style.display = 'none'; $('applyImport').disabled = true; });
  $('allowSharedPhoneImport').addEventListener('change', () => { importPreview = null; $('applyImport').disabled = true; });

  (async () => {
    const valid = await verifySession();
    if (!valid) {
      showLogin();
      await loadUsers();
    }
  })();
})();
