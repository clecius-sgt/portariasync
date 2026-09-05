(() => {
  'use strict';

  const token = localStorage.getItem('authToken') || '';
  const state = { users: [], sessions: [] };
  const $ = id => document.getElementById(id);

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[character]);
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Falha ao comunicar com o servidor.');
    return payload;
  }

  function message(text, type = 'ok') {
    const element = $('message');
    element.textContent = text;
    element.className = 'message ' + type;
    window.setTimeout(() => { element.className = 'message'; }, 5000);
  }

  function formatDate(value) {
    if (!value) return 'Nunca';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Nunca' : date.toLocaleString('pt-BR');
  }

  function userStatus(user) {
    if (!user.ativo) return '<span class="badge inactive">INATIVO</span>';
    if (user.bloqueadoAte && Date.parse(user.bloqueadoAte) > Date.now()) return '<span class="badge locked">BLOQUEADO</span>';
    return '<span class="badge active">ATIVO</span>';
  }

  function render(payload) {
    state.users = payload.users || [];
    state.sessions = payload.sessions || [];
    $('activeCount').textContent = payload.summary?.ativos ?? 0;
    $('inactiveCount').textContent = payload.summary?.inativos ?? 0;
    $('lockedCount').textContent = payload.summary?.bloqueados ?? 0;
    $('sessionCount').textContent = payload.summary?.sessoesAtivas ?? 0;
    $('usersBody').innerHTML = state.users.length ? state.users.map(user => `
      <tr>
        <td><strong>${escapeHtml(user.nome)}</strong>${user.plataforma ? '<div style="font-size:10px;color:#946200">Administrador da plataforma</div>' : ''}</td>
        <td>${escapeHtml(user.perfil)}</td>
        <td>${escapeHtml(user.associacaoNome)}</td>
        <td>${userStatus(user)}</td>
        <td>${escapeHtml(formatDate(user.ultimoLoginEm))}</td>
        <td><div class="actions">
          <button class="btn small secondary" data-action="password" data-id="${escapeHtml(user.id)}">Nova senha</button>
          <button class="btn small secondary" data-action="revoke" data-id="${escapeHtml(user.id)}">Encerrar sessões</button>
          ${user.id === 'u1' ? '' : `<button class="btn small ${user.ativo ? 'danger' : 'success'}" data-action="status" data-id="${escapeHtml(user.id)}" data-active="${user.ativo ? '0' : '1'}">${user.ativo ? 'Desativar' : 'Reativar'}</button>`}
        </div></td>
      </tr>`).join('') : '<tr><td colspan="6" class="empty">Nenhum usuário encontrado.</td></tr>';
    $('sessionsBody').innerHTML = state.sessions.length ? state.sessions.map(session => `
      <tr><td><strong>${escapeHtml(session.nome)}</strong></td><td>${escapeHtml(session.perfil)}</td><td>${escapeHtml(session.associacaoId)}</td><td>${escapeHtml(formatDate(session.vistaEm))}</td><td>${escapeHtml(formatDate(session.expiraEm))}</td><td>${escapeHtml(session.ip || 'Não informado')}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">Nenhuma sessão ativa.</td></tr>';
  }

  async function load() {
    try {
      render(await api('/api/access/overview'));
    } catch (error) {
      message(error.message, 'error');
    }
  }

  async function verifyAccess() {
    if (!token) {
      window.location.href = '/';
      return false;
    }
    try {
      const payload = await api('/api/auth/me');
      if (payload.user?.perfil !== 'admin') throw new Error('Acesso restrito ao administrador.');
      $('currentUser').textContent = payload.user.nome + ' · administrador';
      return true;
    } catch (_) {
      window.location.href = '/';
      return false;
    }
  }

  $('createButton').addEventListener('click', async () => {
    const nome = $('userName').value.trim();
    const perfil = $('userRole').value;
    const senha = $('userPassword').value;
    if (!nome || senha.length < 8) return message('Informe o nome e uma senha com pelo menos 8 caracteres.', 'error');
    try {
      await api('/api/users', { method: 'POST', body: JSON.stringify({ nome, perfil, senha }) });
      $('userName').value = '';
      $('userPassword').value = '';
      message('Usuário criado com segurança.');
      await load();
    } catch (error) { message(error.message, 'error'); }
  });

  $('usersBody').addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const user = state.users.find(item => item.id === button.dataset.id);
    if (!user) return;
    try {
      if (button.dataset.action === 'status') {
        const ativo = button.dataset.active === '1';
        if (!confirm(`${ativo ? 'Reativar' : 'Desativar'} o acesso de ${user.nome}?`)) return;
        await api(`/api/users/${encodeURIComponent(user.id)}/status`, { method: 'PATCH', body: JSON.stringify({ ativo }) });
        message(ativo ? 'Acesso reativado.' : 'Acesso desativado e sessões encerradas.');
      }
      if (button.dataset.action === 'revoke') {
        if (!confirm(`Encerrar todas as sessões de ${user.nome}?`)) return;
        const result = await api(`/api/users/${encodeURIComponent(user.id)}/sessions`, { method: 'DELETE' });
        message(`${result.sessoesRevogadas} sessão(ões) encerrada(s).`);
      }
      if (button.dataset.action === 'password') {
        const senha = prompt(`Nova senha para ${user.nome}. Mínimo de 8 caracteres:`);
        if (senha === null) return;
        if (senha.length < 8) return message('A senha deve ter pelo menos 8 caracteres.', 'error');
        await api(`/api/users/${encodeURIComponent(user.id)}/password`, { method: 'POST', body: JSON.stringify({ senha }) });
        message('Senha alterada e sessões anteriores encerradas.');
      }
      await load();
    } catch (error) { message(error.message, 'error'); }
  });

  $('refreshButton').addEventListener('click', load);
  $('logoutButton').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
    localStorage.removeItem('authToken');
    window.location.href = '/';
  });

  verifyAccess().then(ok => { if (ok) load(); });
})();
