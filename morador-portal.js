(function(){
'use strict';

const VERSION = '2026-09-04.1';
const associationId = new URLSearchParams(location.search).get('associacao') || 'principal';
const tokenKey = 'residentPortalToken:' + associationId;
const ACTIVE_OCCURRENCE_STATUSES = new Set(['aberta','em_apuracao','aguardando_informacao']);
let challengeId = '';
let token = localStorage.getItem(tokenKey) || '';
let packageCache = new Map();
let occurrenceCache = new Map();
let occurrenceByPackage = new Map();

const $ = id => document.getElementById(id);

function show(id){ $(id)?.classList.remove('hidden'); }
function hide(id){ $(id)?.classList.add('hidden'); }
function message(id, text, type='info'){
  const el = $(id); if(!el) return;
  el.textContent = text || '';
  el.className = 'msg ' + type + (text ? '' : ' hidden');
}
function esc(value){
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function normalizeCode(value){ return String(value||'').replace(/\D/g,'').slice(0,6); }
function normalizePhone(value){ return String(value||'').replace(/\D/g,'').slice(0,15); }
function normalizeDocument(value){ return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,30); }
function formatDate(value){
  if(!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('pt-BR');
}

async function api(path, options={}){
  const headers = {'Content-Type':'application/json', ...(options.headers||{})};
  if(token) headers.Authorization = 'Resident ' + token;
  const resp = await fetch(path, {...options, headers});
  let data = null;
  try { data = await resp.json(); } catch(_) {}
  if(!resp.ok){
    const err = new Error(data?.error || 'Não foi possível concluir a operação.');
    err.status = resp.status;
    throw err;
  }
  return data || {};
}

async function requestCode(){
  const phone = normalizePhone($('phone').value);
  if(phone.length < 10){ message('loginMsg','Informe um WhatsApp válido com DDD.','error'); return; }
  $('requestBtn').disabled = true;
  message('loginMsg','Solicitando código...','info');
  try{
    const data = await api('/api/morador/auth/request',{method:'POST',body:JSON.stringify({phone,associationId})});
    challengeId = data.challengeId || '';
    hide('loginCard'); show('codeCard');
    message('codeMsg','', 'info');
    $('otp').value='';
    $('otp').focus();
  }catch(error){
    message('loginMsg', error.message, 'error');
  }finally{
    $('requestBtn').disabled = false;
  }
}

async function verifyCode(){
  const code = normalizeCode($('otp').value);
  if(code.length !== 6){ message('codeMsg','Digite os 6 dígitos recebidos.','error'); return; }
  $('verifyBtn').disabled = true;
  try{
    const data = await api('/api/morador/auth/verify',{method:'POST',body:JSON.stringify({challengeId,code})});
    token = data.token || '';
    localStorage.setItem(tokenKey, token);
    await loadPortal();
  }catch(error){
    message('codeMsg', error.message, 'error');
  }finally{
    $('verifyBtn').disabled = false;
  }
}

function authorizationHtml(item){
  const auth = item.autorizacaoTerceiro;
  if(!auth){
    return `<div class="actions"><button class="secondary" data-authorize="${esc(item.id)}">Autorizar outra pessoa a retirar</button></div>`;
  }
  const active = auth.status === 'ativa';
  const statusLabels = {ativa:'ATIVA',expirada:'EXPIRADA',cancelada:'CANCELADA',substituida:'SUBSTITUÍDA',bloqueada:'BLOQUEADA',utilizada:'UTILIZADA',encerrada:'ENCERRADA'};
  const summary = `<div class="auth-box ${active?'active':''}">
    <div><strong>Autorização digital ${esc(statusLabels[auth.status] || String(auth.status||'').toUpperCase())}</strong></div>
    <div class="meta">Pessoa: <strong>${esc(auth.nome || '-')}</strong><br>Documento: ${esc(auth.documentoMascarado || '-')}<br>Validade: ${esc(formatDate(auth.expiraEm))}</div>
  </div>`;
  if(active){
    return summary + `<div class="actions"><button class="danger" data-cancel-auth="${esc(item.id)}">Cancelar autorização</button></div>`;
  }
  return summary + `<div class="actions"><button class="secondary" data-authorize="${esc(item.id)}">Criar nova autorização</button></div>`;
}

function occurrenceActionsHtml(item){
  if(item.status === 'cancelado') return '';
  const latest = occurrenceByPackage.get(String(item.id));
  if(latest && ACTIVE_OCCURRENCE_STATUSES.has(latest.status)) {
    return `<div class="actions"><button class="warning" data-occurrence-detail="${esc(latest.id)}">Acompanhar ${esc(latest.occurrenceNumber)}</button></div>`;
  }
  const previous = latest ? `<button class="secondary" data-occurrence-detail="${esc(latest.id)}">Ver ${esc(latest.occurrenceNumber)}</button>` : '';
  const label = item.status === 'retirado' ? 'Contestar ou informar problema' : 'Informar problema';
  return `<div class="actions">${previous}<button class="warning" data-report="${esc(item.id)}">${label}</button></div>`;
}

function packageHtml(item){
  const done = item.status === 'retirado';
  const status = done ? 'Retirada' : item.status === 'pendente' ? 'Aguardando retirada' : item.status || 'Status';
  const pinAction = !done ? `<button class="secondary" data-pin="${esc(item.id)}">Reenviar PIN pelo WhatsApp</button>` : '';
  const authorization = !done ? authorizationHtml(item) : (item.autorizacaoTerceiro ? authorizationHtml(item) : '');
  return `<div class="package ${done?'done':''}">
    <div class="top">
      <div><strong>${esc(item.codigo || 'Código não informado')}</strong><div class="meta">${esc(item.transportadora || 'Transportadora não informada')}</div></div>
      <span class="badge">${esc(status)}</span>
    </div>
    <div class="meta">Morador: <strong>${esc(item.moradorNome)}</strong><br>Endereço: ${esc(item.moradorCasa)}<br>Entrada: ${esc(item.dataEntrada || '-')} ${item.dataRetirada ? '<br>Retirada: '+esc(item.dataRetirada) : ''}</div>
    ${item.observacao ? `<div class="meta">Observação: ${esc(item.observacao)}</div>` : ''}
    ${pinAction ? `<div class="actions">${pinAction}<span class="meta">${item.pinAtivo ? 'PIN ativo' : 'Você pode solicitar o PIN.'}</span></div>` : ''}
    ${authorization}
    ${occurrenceActionsHtml(item)}
  </div>`;
}

function renderOccurrences(data){
  const list = data?.occurrences || [];
  occurrenceCache = new Map(list.map(item => [String(item.id), item]));
  occurrenceByPackage = new Map();
  for(const item of list){
    const key = String(item.packageId || '');
    if(key && !occurrenceByPackage.has(key)) occurrenceByPackage.set(key, item);
  }
  const summary = data?.summary || {};
  if(summary.total){
    message('occurrenceSummary', `${summary.abertas || 0} em andamento · ${summary.concluidas || 0} concluída(s) · ${summary.total || 0} total`, 'info');
  }else{
    message('occurrenceSummary','', 'info');
  }
  $('occurrenceList').innerHTML = list.length ? list.map(item => {
    const closed = !ACTIVE_OCCURRENCE_STATUSES.has(item.status);
    return `<div class="occurrence ${closed?'closed':''}">
      <div class="top"><div><div class="occ-number">${esc(item.occurrenceNumber)}</div><div class="occ-title">${esc(item.typeLabel || item.title)}</div></div><span class="occ-badge">${esc(item.statusLabel || item.status)}</span></div>
      <div class="meta">Encomenda: <strong>${esc(item.packageCode || '-')}</strong><br>Aberta: ${esc(formatDate(item.openedAt))}${item.outcomeLabel ? '<br>Resultado: '+esc(item.outcomeLabel) : ''}</div>
      <div class="actions"><button class="secondary" data-occurrence-detail="${esc(item.id)}">Ver andamento</button></div>
    </div>`;
  }).join('') : '<div class="empty">Nenhuma ocorrência aberta por este portal.</div>';
}

function bindPackageActions(){
  document.querySelectorAll('[data-pin]').forEach(btn => btn.addEventListener('click', () => resendPin(btn.dataset.pin, btn)));
  document.querySelectorAll('[data-authorize]').forEach(btn => btn.addEventListener('click', () => openAuthorizationDialog(btn.dataset.authorize)));
  document.querySelectorAll('[data-cancel-auth]').forEach(btn => btn.addEventListener('click', () => cancelAuthorization(btn.dataset.cancelAuth, btn)));
  document.querySelectorAll('[data-report]').forEach(btn => btn.addEventListener('click', () => openOccurrenceDialog(btn.dataset.report)));
  document.querySelectorAll('[data-occurrence-detail]').forEach(btn => btn.addEventListener('click', () => openOccurrenceDetail(btn.dataset.occurrenceDetail)));
}

async function loadPortal(){
  if(!token){ show('loginCard'); hide('codeCard'); hide('portal'); return; }
  try{
    const [me, data, occurrenceData] = await Promise.all([
      api('/api/morador/me'),
      api('/api/morador/encomendas'),
      api('/api/morador/ocorrencias')
    ]);
    hide('loginCard'); hide('codeCard'); show('portal');
    const associationName = me.association?.nome || me.association?.name || '';
    if($('associationName')) $('associationName').textContent = associationName || 'Associação de Moradores';
    $('maskedPhone').textContent = 'Acesso validado pelo WhatsApp ' + (me.phone || '');
    const first = me.residents?.[0];
    $('welcome').textContent = first ? 'Olá, ' + first.nome.split(' ')[0] : 'Portal do Morador';
    $('statPending').textContent = me.summary?.pendentes ?? 0;
    $('statDone').textContent = me.summary?.retiradas ?? 0;
    $('statTotal').textContent = me.summary?.total ?? 0;
    $('residentList').innerHTML = (me.residents||[]).map(r => `<div class="resident"><b>${esc(r.nome)}</b><small>${esc(r.casa)}</small></div>`).join('') || '<div class="empty">Nenhum cadastro vinculado.</div>';
    const packages = data.packages || [];
    packageCache = new Map(packages.map(item => [String(item.id), item]));
    renderOccurrences(occurrenceData);
    const pending = packages.filter(p => p.status === 'pendente');
    const history = packages.filter(p => p.status !== 'pendente');
    $('pendingList').innerHTML = pending.map(packageHtml).join('') || '<div class="empty">Nenhuma encomenda aguardando retirada.</div>';
    $('historyList').innerHTML = history.map(packageHtml).join('') || '<div class="empty">Ainda não há histórico de retiradas.</div>';
    bindPackageActions();
  }catch(error){
    if(error.status === 401){
      token=''; localStorage.removeItem(tokenKey);
      hide('portal'); hide('codeCard'); show('loginCard');
      message('loginMsg','Sua sessão expirou. Solicite um novo código.','info');
      return;
    }
    alert(error.message);
  }
}

async function resendPin(id, button){
  if(!confirm('Reenviar o PIN desta encomenda para o WhatsApp cadastrado?')) return;
  const old = button.textContent;
  button.disabled = true; button.textContent = 'Enviando...';
  try{
    const data = await api('/api/morador/encomendas/' + encodeURIComponent(id) + '/reenviar-pin',{method:'POST',body:'{}'});
    alert(data.message || 'PIN reenviado pelo WhatsApp.');
    await loadPortal();
  }catch(error){
    alert(error.message);
  }finally{
    button.disabled = false; button.textContent = old;
  }
}

function closeAuthorizationDialog(){
  document.getElementById('authorizationModal')?.remove();
}

function openAuthorizationDialog(id){
  const item = packageCache.get(String(id));
  if(!item || item.status !== 'pendente') return;
  closeAuthorizationDialog();
  const modal = document.createElement('div');
  modal.id = 'authorizationModal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `<div class="modal-card">
    <h3>Autorizar retirada por terceiro</h3>
    <p>Esta autorização vale somente para a encomenda <strong>${esc(item.codigo || item.id)}</strong>. A pessoa autorizada deverá apresentar o documento e o código de 6 dígitos.</p>
    <label for="authorizedName">Nome completo</label>
    <input id="authorizedName" autocomplete="name" maxlength="120" placeholder="Nome da pessoa autorizada">
    <label for="authorizedDocument">Documento</label>
    <input id="authorizedDocument" maxlength="30" placeholder="RG, CNH ou outro documento">
    <label for="authorizationValidity">Validade</label>
    <select id="authorizationValidity">
      <option value="4">4 horas</option>
      <option value="12">12 horas</option>
      <option value="24" selected>24 horas</option>
      <option value="48">48 horas</option>
    </select>
    <div id="authorizationMsg" class="msg error hidden"></div>
    <div class="modal-actions">
      <button id="authorizationCancel" class="secondary">Voltar</button>
      <button id="authorizationSave" class="primary compact">Criar autorização</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
  $('authorizationCancel').addEventListener('click', closeAuthorizationDialog);
  modal.addEventListener('click', event => { if(event.target === modal) closeAuthorizationDialog(); });
  $('authorizationSave').addEventListener('click', () => createAuthorization(id));
  $('authorizedName').focus();
}

async function createAuthorization(id){
  const nome = $('authorizedName').value.trim().replace(/\s+/g,' ');
  const documento = normalizeDocument($('authorizedDocument').value);
  const validadeHoras = Number($('authorizationValidity').value || 24);
  if(nome.length < 3){ message('authorizationMsg','Informe o nome completo da pessoa autorizada.','error'); return; }
  if(documento.length < 4){ message('authorizationMsg','Informe um documento válido.','error'); return; }
  const button = $('authorizationSave');
  button.disabled = true; button.textContent = 'Criando...';
  try{
    const data = await api('/api/morador/encomendas/' + encodeURIComponent(id) + '/autorizacao',{
      method:'POST', body:JSON.stringify({nome,documento,validadeHoras})
    });
    closeAuthorizationDialog();
    const whatsapp = data.whatsappEnviado ? '\nTambém enviamos a confirmação para o seu WhatsApp.' : '\nGuarde este código: a confirmação pelo WhatsApp não pôde ser enviada.';
    alert('Autorização criada com sucesso.\n\nCódigo de autorização: ' + data.codigo + '\n\nInforme este código somente à pessoa autorizada.' + whatsapp);
    await loadPortal();
  }catch(error){
    message('authorizationMsg', error.message, 'error');
  }finally{
    if(button){ button.disabled = false; button.textContent = 'Criar autorização'; }
  }
}

async function cancelAuthorization(id, button){
  if(!confirm('Cancelar a autorização digital desta encomenda?')) return;
  const old = button.textContent;
  button.disabled = true; button.textContent = 'Cancelando...';
  try{
    const data = await api('/api/morador/encomendas/' + encodeURIComponent(id) + '/autorizacao',{method:'DELETE',body:'{}'});
    alert(data.message || 'Autorização cancelada.');
    await loadPortal();
  }catch(error){
    alert(error.message);
  }finally{
    button.disabled = false; button.textContent = old;
  }
}

function closeOccurrenceDialog(){
  document.getElementById('occurrenceModal')?.remove();
}

function occurrenceTypeOptions(item){
  if(item.status === 'retirado'){
    return [
      ['contestacao_retirada','Não reconheço ou contesto a retirada'],
      ['encomenda_danificada','Encomenda danificada'],
      ['outro','Outro problema']
    ];
  }
  return [
    ['encomenda_nao_localizada','Encomenda não localizada para retirada'],
    ['encomenda_danificada','Encomenda danificada'],
    ['outro','Outro problema']
  ];
}

function openOccurrenceDialog(id){
  const item = packageCache.get(String(id));
  if(!item || item.status === 'cancelado') return;
  closeOccurrenceDialog();
  const modal = document.createElement('div');
  modal.id = 'occurrenceModal';
  modal.className = 'modal-overlay';
  const options = occurrenceTypeOptions(item).map(([value,label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
  modal.innerHTML = `<div class="modal-card">
    <h3>Informar problema com a encomenda</h3>
    <p>O relato será registrado como ocorrência formal e ficará vinculado à encomenda <strong>${esc(item.codigo || item.id)}</strong>.</p>
    <label for="occurrenceType">Tipo do problema</label>
    <select id="occurrenceType">${options}</select>
    <label for="occurrenceDescription">Descreva o que aconteceu</label>
    <textarea id="occurrenceDescription" maxlength="4000" placeholder="Explique o problema de forma objetiva. Mínimo de 20 caracteres."></textarea>
    <div id="occurrenceMsg" class="msg error hidden"></div>
    <div class="modal-actions">
      <button id="occurrenceCancel" class="secondary">Voltar</button>
      <button id="occurrenceSave" class="primary compact">Registrar ocorrência</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
  $('occurrenceCancel').addEventListener('click', closeOccurrenceDialog);
  modal.addEventListener('click', event => { if(event.target === modal) closeOccurrenceDialog(); });
  $('occurrenceSave').addEventListener('click', () => createOccurrence(id));
  $('occurrenceDescription').focus();
}

async function createOccurrence(packageId){
  const type = $('occurrenceType').value;
  const description = $('occurrenceDescription').value.trim().replace(/\s+/g,' ');
  if(description.length < 20){ message('occurrenceMsg','Descreva o problema com pelo menos 20 caracteres.','error'); return; }
  const button = $('occurrenceSave');
  button.disabled = true; button.textContent = 'Registrando...';
  try{
    const data = await api('/api/morador/encomendas/' + encodeURIComponent(packageId) + '/ocorrencia',{
      method:'POST', body:JSON.stringify({type,description})
    });
    closeOccurrenceDialog();
    const confirmation = data.whatsappConfirmado ? '\nUma confirmação também foi enviada ao seu WhatsApp.' : '';
    alert('Ocorrência ' + data.occurrence.occurrenceNumber + ' registrada com sucesso.' + confirmation);
    await loadPortal();
    await openOccurrenceDetail(data.occurrence.id);
  }catch(error){
    message('occurrenceMsg', error.message, 'error');
  }finally{
    if(button){ button.disabled = false; button.textContent = 'Registrar ocorrência'; }
  }
}

async function openOccurrenceDetail(id){
  try{
    const data = await api('/api/morador/ocorrencias/' + encodeURIComponent(id));
    closeOccurrenceDialog();
    const occ = data.occurrence;
    const active = ACTIVE_OCCURRENCE_STATUSES.has(occ.status);
    const modal = document.createElement('div');
    modal.id = 'occurrenceModal';
    modal.className = 'modal-overlay';
    const timeline = (data.timeline || []).map(event => `<div class="timeline-item"><strong>${esc(event.title)}</strong><div class="meta">${esc(formatDate(event.occurredAt))}</div>${event.description ? `<div class="meta" style="color:#334155">${esc(event.description)}</div>` : ''}</div>`).join('');
    modal.innerHTML = `<div class="modal-card">
      <h3>${esc(occ.occurrenceNumber)} · ${esc(occ.typeLabel)}</h3>
      <p>Encomenda <strong>${esc(occ.packageCode || '-')}</strong></p>
      <div class="msg ${data.integrity?.status === 'ok' ? 'ok' : 'error'}">${data.integrity?.status === 'ok' ? 'Linha do tempo verificada por SHA-256.' : 'Falha na verificação de integridade.'}</div>
      <div class="meta" style="margin-top:12px">Status: <strong>${esc(occ.statusLabel)}</strong><br>Aberta em: ${esc(formatDate(occ.openedAt))}${occ.receiptNumber ? '<br>Comprovante relacionado: '+esc(occ.receiptNumber) : ''}</div>
      <div style="margin-top:12px"><strong>Relato inicial</strong><div class="meta" style="color:#334155">${esc(occ.description)}</div></div>
      ${occ.status === 'concluida' ? `<div class="msg ok"><strong>Resultado: ${esc(occ.outcomeLabel || '-')}</strong><br>${esc(occ.conclusion || '')}</div>` : ''}
      <div class="timeline">${timeline || '<div class="empty">Sem eventos públicos.</div>'}</div>
      ${active ? `<label for="residentStatement">Acrescentar informação</label><textarea id="residentStatement" maxlength="4000" placeholder="Inclua uma nova informação relevante para a apuração."></textarea><div id="statementMsg" class="msg error hidden"></div>` : ''}
      <div class="modal-actions">
        <button id="occurrenceClose" class="secondary">Fechar</button>
        ${active ? '<button id="statementSave" class="primary compact">Enviar manifestação</button>' : ''}
      </div>
    </div>`;
    document.body.appendChild(modal);
    $('occurrenceClose').addEventListener('click', closeOccurrenceDialog);
    modal.addEventListener('click', event => { if(event.target === modal) closeOccurrenceDialog(); });
    if(active) $('statementSave').addEventListener('click', () => addOccurrenceStatement(occ.id));
  }catch(error){
    alert(error.message);
  }
}

async function addOccurrenceStatement(id){
  const text = $('residentStatement').value.trim().replace(/\s+/g,' ');
  if(text.length < 10){ message('statementMsg','A manifestação deve possuir pelo menos 10 caracteres.','error'); return; }
  const button = $('statementSave');
  button.disabled = true; button.textContent = 'Enviando...';
  try{
    await api('/api/morador/ocorrencias/' + encodeURIComponent(id) + '/manifestacao',{
      method:'POST', body:JSON.stringify({text})
    });
    closeOccurrenceDialog();
    await loadPortal();
    await openOccurrenceDetail(id);
  }catch(error){
    message('statementMsg', error.message, 'error');
  }finally{
    if(button){ button.disabled = false; button.textContent = 'Enviar manifestação'; }
  }
}

async function logout(){
  try{ if(token) await api('/api/morador/logout',{method:'POST',body:'{}'}); }catch(_){}
  token=''; challengeId=''; localStorage.removeItem(tokenKey);
  packageCache = new Map(); occurrenceCache = new Map(); occurrenceByPackage = new Map();
  hide('portal'); hide('codeCard'); show('loginCard');
  $('phone').value=''; $('otp').value='';
  message('loginMsg','Sessão encerrada.','ok');
}

$('requestBtn').addEventListener('click', requestCode);
$('verifyBtn').addEventListener('click', verifyCode);
$('backBtn').addEventListener('click', () => { challengeId=''; hide('codeCard'); show('loginCard'); });
$('refreshBtn').addEventListener('click', loadPortal);
$('logoutBtn').addEventListener('click', logout);
$('otp').addEventListener('input', function(){ this.value = normalizeCode(this.value); });
$('phone').addEventListener('keydown', e => { if(e.key === 'Enter') requestCode(); });
$('otp').addEventListener('keydown', e => { if(e.key === 'Enter') verifyCode(); });

window.PortariaSyncResidentPortal = { version: VERSION, associationId, reload: loadPortal, openOccurrence: openOccurrenceDetail };
loadPortal();
})();
