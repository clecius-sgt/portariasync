'use strict';

const TYPES = {
  contestacao_retirada:'Contestação de retirada', encomenda_danificada:'Encomenda danificada',
  destinatario_incorreto:'Destinatário incorreto', entrega_equivocada:'Entrega equivocada',
  encomenda_nao_localizada:'Encomenda não localizada', divergencia_transportadora:'Divergência com transportadora',
  recusa_destinatario:'Recusa do destinatário', suspeita_documental:'Suspeita documental', outro:'Outro'
};
const PRIORITIES = { baixa:'Baixa', normal:'Normal', alta:'Alta', critica:'Crítica' };
const STATUSES = { aberta:'Aberta', em_apuracao:'Em apuração', aguardando_informacao:'Aguardando informação', concluida:'Concluída', cancelada:'Cancelada' };
const OUTCOMES = {
  entrega_confirmada:'Entrega confirmada', erro_operacional_confirmado:'Erro operacional confirmado',
  entrega_equivocada:'Entrega equivocada', encomenda_localizada:'Encomenda localizada',
  divergencia_resolvida:'Divergência resolvida', responsabilidade_transportadora:'Responsabilidade da transportadora',
  sem_elementos_suficientes:'Sem elementos suficientes', outro:'Outro'
};

let currentUser = null;
let appPackages = [];
let occurrences = [];
let metrics = {};
let selectedId = null;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function authToken() {
  return localStorage.getItem('authToken') || '';
}

async function apiFetch(url, options = {}) {
  const token = authToken();
  const response = await fetch(url, {
    ...options,
    headers:{ 'Content-Type':'application/json', ...(options.headers || {}), ...(token ? {Authorization:'Bearer ' + token} : {}) }
  });
  if (!response.ok) {
    let data = null;
    try { data = await response.json(); } catch (_) {}
    const error = new Error(data?.error || data?.detail || `Erro ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const type = response.headers.get('content-type') || '';
  return type.includes('application/json') ? response.json() : response;
}
window.apiFetch = apiFetch;

function showNotice(message, type = 'bad') {
  const el = document.getElementById('notice');
  if (!message) { el.className = 'notice'; el.textContent = ''; return; }
  el.className = 'notice show ' + type;
  el.textContent = message;
  setTimeout(() => { if (el.textContent === message) showNotice(''); }, 7000);
}

function formatDate(value) {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString('pt-BR');
}

function bytes(value) {
  const n = Number(value || 0);
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function statusClass(value) {
  return value === 'concluida' ? 'b-done' : value === 'cancelada' ? 'b-cancel' : value === 'em_apuracao' ? 'b-progress' : value === 'aguardando_informacao' ? 'b-wait' : 'b-open';
}

function priorityClass(value) {
  return 'p-' + (value || 'normal');
}

function fillSelect(id, map, selected = '') {
  const el = document.getElementById(id);
  if (!el) return;
  const first = el.options.length && el.options[0].value === '' ? el.options[0].outerHTML : '';
  el.innerHTML = first + Object.entries(map).map(([value,label]) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`).join('');
}

function packageLabel(pkg) {
  return `${pkg.codigo || 'Sem código'} - ${pkg.moradorNome || 'Sem destinatário'} - ${pkg.status || ''}`;
}

function fillPackageSelect(preselect = '') {
  const el = document.getElementById('newPackage');
  el.innerHTML = '<option value="">Selecione a encomenda</option>' + appPackages.map(pkg =>
    `<option value="${esc(pkg.id)}" ${String(pkg.id) === String(preselect) ? 'selected' : ''}>${esc(packageLabel(pkg))}</option>`
  ).join('');
}

function renderMetrics() {
  document.getElementById('mTotal').textContent = metrics.total || 0;
  document.getElementById('mOpen').textContent = metrics.opened || 0;
  document.getElementById('mProgress').textContent = metrics.inProgress || 0;
  document.getElementById('mCritical').textContent = metrics.critical || 0;
  document.getElementById('mDone').textContent = metrics.concluded || 0;
}

function filteredOccurrences() {
  const q = document.getElementById('filterQ').value.trim().toLowerCase();
  const status = document.getElementById('filterStatus').value;
  const priority = document.getElementById('filterPriority').value;
  const type = document.getElementById('filterType').value;
  return occurrences.filter(item => {
    if (status && item.status !== status) return false;
    if (priority && item.priority !== priority) return false;
    if (type && item.type !== type) return false;
    if (!q) return true;
    return [item.occurrenceNumber,item.packageCode,item.residentName,item.title,item.typeLabel]
      .some(value => String(value || '').toLowerCase().includes(q));
  });
}

function renderList() {
  const div = document.getElementById('occurrenceList');
  const list = filteredOccurrences();
  if (!list.length) {
    div.innerHTML = '<div class="empty">Nenhuma ocorrência encontrada.</div>';
    return;
  }
  div.innerHTML = list.map(item => `
    <div class="occ-item ${String(item.id) === String(selectedId) ? 'active' : ''}" onclick="openDetail('${esc(item.id)}')">
      <div class="occ-top"><div class="occ-number">${esc(item.occurrenceNumber)}</div><span class="badge ${statusClass(item.status)}">${esc(item.statusLabel)}</span></div>
      <div class="occ-title">${esc(item.title)}</div>
      <div class="occ-meta">${esc(item.packageCode)} · ${esc(item.residentName)}<br>${esc(formatDate(item.openedAt))} · <span class="badge ${priorityClass(item.priority)}">${esc(item.priorityLabel)}</span></div>
    </div>`).join('');
}

function openNew(packageId = '') {
  const panel = document.getElementById('newPanel');
  panel.classList.add('open');
  fillPackageSelect(packageId || document.getElementById('newPackage')?.value || '');
  panel.scrollIntoView({behavior:'smooth',block:'start'});
}

function closeNew() {
  document.getElementById('newPanel').classList.remove('open');
  document.getElementById('newDescription').value = '';
  document.getElementById('newTitle').value = '';
}

async function createOccurrence() {
  const body = {
    packageId:document.getElementById('newPackage').value,
    type:document.getElementById('newType').value,
    priority:document.getElementById('newPriority').value,
    title:document.getElementById('newTitle').value.trim(),
    description:document.getElementById('newDescription').value.trim()
  };
  try {
    const result = await apiFetch('/api/occurrences', {method:'POST',body:JSON.stringify(body)});
    closeNew();
    showNotice('Ocorrência ' + result.occurrence.occurrenceNumber + ' registrada.', 'ok');
    await loadOccurrences();
    await openDetail(result.occurrence.id);
  } catch (error) {
    showNotice(error.message);
  }
}

async function loadOccurrences() {
  try {
    const data = await apiFetch('/api/occurrences');
    occurrences = data.occurrences || [];
    metrics = data.metrics || {};
    renderMetrics();
    renderList();
  } catch (error) {
    showNotice(error.message);
  }
}

function actionButtons(occ) {
  const canManage = ['admin','supervisor'].includes(currentUser?.perfil);
  const isAdmin = currentUser?.perfil === 'admin';
  let html = '<div class="actions-row">';
  if (occ.receiptNumber) html += `<button class="btn btn-blue" type="button" onclick="openReceipt('${esc(occ.packageId)}')">Ver comprovante ${esc(occ.receiptNumber)}</button>`;
  if (canManage && !['concluida','cancelada'].includes(occ.status)) {
    html += `<button class="btn btn-soft" type="button" onclick="quickStatus('${esc(occ.id)}','em_apuracao')">Em apuração</button>`;
    html += `<button class="btn btn-soft" type="button" onclick="quickStatus('${esc(occ.id)}','aguardando_informacao')">Aguardando informação</button>`;
  }
  if (isAdmin && !['concluida','cancelada'].includes(occ.status)) {
    html += `<button class="btn btn-navy" type="button" onclick="showConclusion('${esc(occ.id)}')">Concluir</button>`;
    html += `<button class="btn btn-bad" type="button" onclick="cancelOccurrence('${esc(occ.id)}')">Cancelar ocorrência</button>`;
  }
  if (isAdmin && ['concluida','cancelada'].includes(occ.status)) html += `<button class="btn btn-warn" type="button" onclick="reopenOccurrence('${esc(occ.id)}')">Reabrir</button>`;
  html += '</div>';
  return html;
}

function detailHtml(data) {
  const occ = data.occurrence;
  const isAdmin = currentUser?.perfil === 'admin';
  const canManage = ['admin','supervisor'].includes(currentUser?.perfil);
  const events = data.events || [];
  const attachments = data.attachments || [];
  return `
    <h2>${esc(occ.occurrenceNumber)} · ${esc(occ.title)}</h2>
    <div class="detail-sub">Aberta em ${esc(formatDate(occ.openedAt))} por ${esc(occ.createdBy?.name || '-')}</div>
    <div class="integrity ${data.integrity?.status === 'ok' ? 'ok' : 'bad'}">${data.integrity?.status === 'ok' ? 'Linha do tempo íntegra e encadeada por SHA-256' : 'Falha na verificação da linha do tempo'} · ${Number(data.integrity?.eventCount || 0)} evento(s)</div>
    <div class="summary-grid">
      <div class="kv"><div class="k">Encomenda</div><div class="v">${esc(occ.packageCode || '-')}</div></div>
      <div class="kv"><div class="k">Morador</div><div class="v">${esc(occ.residentName || '-')}</div></div>
      <div class="kv"><div class="k">Endereço / unidade</div><div class="v">${esc(occ.residentHouse || '-')}</div></div>
      <div class="kv"><div class="k">Comprovante</div><div class="v">${esc(occ.receiptNumber || 'Não aplicável')}</div></div>
      <div class="kv"><div class="k">Tipo</div><div class="v">${esc(occ.typeLabel)}</div></div>
      <div class="kv"><div class="k">Status</div><div class="v"><span class="badge ${statusClass(occ.status)}">${esc(occ.statusLabel)}</span></div></div>
      <div class="kv"><div class="k">Prioridade</div><div class="v"><span class="badge ${priorityClass(occ.priority)}">${esc(occ.priorityLabel)}</span></div></div>
      <div class="kv"><div class="k">Última atualização</div><div class="v">${esc(formatDate(occ.updatedAt))}</div></div>
    </div>
    <div class="section"><h3>Relato inicial</h3><div class="small" style="font-size:13px;color:#334155;">${esc(occ.description)}</div></div>
    ${occ.status === 'concluida' ? `<div class="section"><h3>Conclusão administrativa</h3><div class="kv"><div class="k">Resultado</div><div class="v">${esc(occ.outcomeLabel || '-')}</div></div><div class="small" style="font-size:13px;color:#334155;margin-top:9px;">${esc(occ.conclusion || '')}</div></div>` : ''}
    ${occ.status === 'cancelada' ? `<div class="section"><h3>Cancelamento</h3><div class="small" style="font-size:13px;color:#334155;">${esc(occ.conclusion || '')}</div></div>` : ''}
    <div class="section"><h3>Ações</h3>${actionButtons(occ)}
      ${canManage ? `<div class="form-grid" style="margin-top:10px;"><div class="field"><label>Prioridade</label><select id="detailPriority">${Object.entries(PRIORITIES).map(([k,v]) => `<option value="${k}" ${occ.priority === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div><div class="field" style="display:flex;align-items:flex-end;"><button class="btn btn-soft" type="button" onclick="changePriority('${esc(occ.id)}')">Salvar prioridade</button></div></div>` : ''}
    </div>
    <div class="section"><h3>Registrar andamento</h3><div class="form-grid"><div class="field"><label>Tipo</label><select id="noteKind"><option value="administrative_note">Nota administrativa</option><option value="resident_statement">Manifestação do morador</option></select></div><div></div><div class="field full"><label>Registro</label><textarea id="noteText" maxlength="4000" placeholder="Registre o contato, diligência, verificação ou manifestação."></textarea></div><div class="field full"><button class="btn btn-navy" type="button" onclick="addNote('${esc(occ.id)}')">Adicionar à linha do tempo</button></div></div></div>
    <div class="section"><h3>Evidências anexadas</h3>
      ${attachments.length ? attachments.map(att => `<div class="attachment"><div><div class="attachment-name">${esc(att.fileName)}</div><div class="attachment-meta">${esc(att.mimeType)} · ${esc(bytes(att.sizeBytes))}<br><span class="hash">SHA-256 ${esc(att.sha256)}</span></div></div><button class="btn btn-soft" type="button" onclick="downloadAttachment('${esc(occ.id)}','${esc(att.id)}','${esc(att.fileName)}')">Baixar</button></div>`).join('') : '<div class="small">Nenhum anexo registrado.</div>'}
      <div class="form-grid" style="margin-top:10px;"><div class="field full"><label>Anexar evidência - máximo 2 MB por arquivo</label><input id="attachmentInput" type="file" accept="image/jpeg,image/png,image/webp,application/pdf,text/plain"></div><div class="field full"><button class="btn btn-soft" type="button" onclick="uploadAttachment('${esc(occ.id)}')">Anexar com hash SHA-256</button></div></div>
    </div>
    <div id="conclusionArea" class="section hidden"><h3>Concluir ocorrência</h3><div class="form-grid"><div class="field"><label>Resultado</label><select id="conclusionOutcome">${Object.entries(OUTCOMES).map(([k,v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div><div></div><div class="field full"><label>Conclusão fundamentada</label><textarea id="conclusionText" maxlength="5000" placeholder="Mínimo de 20 caracteres."></textarea></div><div class="field full"><button class="btn btn-navy" type="button" onclick="concludeOccurrence('${esc(occ.id)}')">Registrar conclusão</button></div></div></div>
    <div class="section"><h3>Linha do tempo</h3><div class="timeline">${events.map(event => `<div class="event"><div class="event-title">${esc(event.title)}</div><div class="event-desc">${esc(event.description || '')}</div><div class="event-meta">${esc(formatDate(event.occurredAt))} · ${esc(event.actor?.name || 'PortalSync')} · ${esc(event.actor?.role || '')}<br>Evento #${Number(event.seq || 0)} · hash ${esc(String(event.hash || '').slice(0,16))}...</div></div>`).join('')}</div></div>
    <div class="section small">O histórico da ocorrência é append-only. Cancelamentos e reaberturas não apagam eventos anteriores. Anexos são verificados por SHA-256.</div>
  `;
}

async function openDetail(id) {
  selectedId = id;
  renderList();
  const panel = document.getElementById('detailPanel');
  panel.innerHTML = '<div class="empty">Carregando ocorrência...</div>';
  try {
    const data = await apiFetch('/api/occurrences/' + encodeURIComponent(id));
    panel.innerHTML = detailHtml(data);
  } catch (error) {
    panel.innerHTML = '<div class="empty">' + esc(error.message) + '</div>';
  }
}
window.openDetail = openDetail;

async function postAction(id, path, body, success) {
  try {
    const data = await apiFetch('/api/occurrences/' + encodeURIComponent(id) + path, {method:'POST',body:JSON.stringify(body || {})});
    showNotice(success || 'Ocorrência atualizada.', 'ok');
    await loadOccurrences();
    selectedId = data.occurrence?.id || id;
    await openDetail(selectedId);
    return data;
  } catch (error) {
    showNotice(error.message);
    return null;
  }
}

async function addNote(id) {
  const text = document.getElementById('noteText').value.trim();
  const kind = document.getElementById('noteKind').value;
  await postAction(id, '/notes', {text,kind}, 'Registro acrescentado à linha do tempo.');
}
window.addNote = addNote;

async function quickStatus(id, status) {
  await postAction(id, '/status', {status}, 'Status atualizado.');
}
window.quickStatus = quickStatus;

async function changePriority(id) {
  await postAction(id, '/priority', {priority:document.getElementById('detailPriority').value}, 'Prioridade atualizada.');
}
window.changePriority = changePriority;

function showConclusion() {
  document.getElementById('conclusionArea')?.classList.remove('hidden');
  document.getElementById('conclusionArea')?.scrollIntoView({behavior:'smooth',block:'center'});
}
window.showConclusion = showConclusion;

async function concludeOccurrence(id) {
  const outcome = document.getElementById('conclusionOutcome').value;
  const conclusion = document.getElementById('conclusionText').value.trim();
  await postAction(id, '/conclude', {outcome,conclusion}, 'Ocorrência concluída e registrada na Cadeia de Custódia.');
}
window.concludeOccurrence = concludeOccurrence;

async function reopenOccurrence(id) {
  const reason = prompt('Informe o motivo da reabertura. Mínimo de 20 caracteres:') || '';
  if (!reason) return;
  await postAction(id, '/reopen', {reason}, 'Ocorrência reaberta sem apagar o histórico anterior.');
}
window.reopenOccurrence = reopenOccurrence;

async function cancelOccurrence(id) {
  const reason = prompt('Informe o motivo do cancelamento. Mínimo de 20 caracteres:') || '';
  if (!reason) return;
  await postAction(id, '/cancel', {reason}, 'Ocorrência cancelada sem exclusão do histórico.');
}
window.cancelOccurrence = cancelOccurrence;

function fileToBase64(file) {
  return new Promise((resolve,reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',').pop() || '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadAttachment(id) {
  const input = document.getElementById('attachmentInput');
  const file = input?.files?.[0];
  if (!file) { showNotice('Selecione um arquivo para anexar.'); return; }
  if (file.size > 2 * 1024 * 1024) { showNotice('O arquivo ultrapassa o limite de 2 MB.'); return; }
  try {
    const base64 = await fileToBase64(file);
    await postAction(id, '/attachments', {fileName:file.name,mimeType:file.type || 'application/octet-stream',base64}, 'Evidência anexada com hash SHA-256.');
  } catch (error) {
    showNotice(error.message);
  }
}
window.uploadAttachment = uploadAttachment;

async function downloadAttachment(occurrenceId, attachmentId, fileName) {
  try {
    const response = await fetch('/api/occurrences/' + encodeURIComponent(occurrenceId) + '/attachments/' + encodeURIComponent(attachmentId), {headers:{Authorization:'Bearer ' + authToken()}});
    if (!response.ok) throw new Error('Não foi possível baixar o anexo.');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'anexo';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  } catch (error) {
    showNotice(error.message);
  }
}
window.downloadAttachment = downloadAttachment;

function openReceipt(packageId) {
  if (window.WithdrawalReceiptUI?.open) window.WithdrawalReceiptUI.open(packageId);
  else showNotice('Comprovante não disponível nesta sessão.');
}
window.openReceipt = openReceipt;

async function init() {
  fillSelect('newType', TYPES, 'contestacao_retirada');
  fillSelect('newPriority', PRIORITIES, 'normal');
  fillSelect('filterStatus', STATUSES);
  fillSelect('filterPriority', PRIORITIES);
  fillSelect('filterType', TYPES);

  document.getElementById('newButton').addEventListener('click', () => openNew());
  document.getElementById('cancelNewButton').addEventListener('click', closeNew);
  document.getElementById('createButton').addEventListener('click', createOccurrence);
  document.getElementById('refreshButton').addEventListener('click', async () => { await loadOccurrences(); if (selectedId) await openDetail(selectedId); });
  for (const id of ['filterQ','filterStatus','filterPriority','filterType']) {
    document.getElementById(id).addEventListener(id === 'filterQ' ? 'input' : 'change', renderList);
  }

  if (!authToken()) {
    showNotice('Faça login no PortalSync antes de acessar a Central de Ocorrências.');
    document.getElementById('newButton').disabled = true;
    return;
  }

  try {
    const me = await apiFetch('/api/auth/me');
    currentUser = me.user;
    document.getElementById('currentUser').textContent = `${currentUser.nome} · ${currentUser.perfil}`;
    const appState = await apiFetch('/api/app-state');
    appPackages = appState.encomendas || [];
    fillPackageSelect();
    await loadOccurrences();

    const params = new URLSearchParams(location.search);
    const packageId = params.get('package') || '';
    if (packageId) {
      openNew(packageId);
      const related = occurrences.find(item => String(item.packageId) === String(packageId));
      if (related) await openDetail(related.id);
    }
  } catch (error) {
    showNotice(error.status === 403 ? 'Sua sessão expirou. Volte ao PortalSync e faça login novamente.' : error.message);
  }
}

document.addEventListener('DOMContentLoaded', init, {once:true});
