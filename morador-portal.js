(function(){
'use strict';

const VERSION = '2026-09-03.3';
const associationId = new URLSearchParams(location.search).get('associacao') || 'principal';
const tokenKey = 'residentPortalToken:' + associationId;
let challengeId = '';
let token = localStorage.getItem(tokenKey) || '';
let packageCache = new Map();

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
  </div>`;
}

function bindPackageActions(){
  document.querySelectorAll('[data-pin]').forEach(btn => btn.addEventListener('click', () => resendPin(btn.dataset.pin, btn)));
  document.querySelectorAll('[data-authorize]').forEach(btn => btn.addEventListener('click', () => openAuthorizationDialog(btn.dataset.authorize)));
  document.querySelectorAll('[data-cancel-auth]').forEach(btn => btn.addEventListener('click', () => cancelAuthorization(btn.dataset.cancelAuth, btn)));
}

async function loadPortal(){
  if(!token){ show('loginCard'); hide('codeCard'); hide('portal'); return; }
  try{
    const [me, data] = await Promise.all([
      api('/api/morador/me'),
      api('/api/morador/encomendas')
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

async function logout(){
  try{ if(token) await api('/api/morador/logout',{method:'POST',body:'{}'}); }catch(_){}
  token=''; challengeId=''; localStorage.removeItem(tokenKey);
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

window.PortariaSyncResidentPortal = { version: VERSION, associationId, reload: loadPortal };
loadPortal();
})();
