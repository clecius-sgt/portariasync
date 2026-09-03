(function(){
'use strict';

const VERSION = '2026-09-03.2';
const associationId = new URLSearchParams(location.search).get('associacao') || 'principal';
const tokenKey = 'residentPortalToken:' + associationId;
let challengeId = '';
let token = localStorage.getItem(tokenKey) || '';

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

function packageHtml(item){
  const done = item.status === 'retirado';
  const status = done ? 'Retirada' : item.status === 'pendente' ? 'Aguardando retirada' : item.status || 'Status';
  const pinAction = !done ? `<button class="secondary" data-pin="${esc(item.id)}">Reenviar PIN pelo WhatsApp</button>` : '';
  return `<div class="package ${done?'done':''}">
    <div class="top">
      <div><strong>${esc(item.codigo || 'Código não informado')}</strong><div class="meta">${esc(item.transportadora || 'Transportadora não informada')}</div></div>
      <span class="badge">${esc(status)}</span>
    </div>
    <div class="meta">Morador: <strong>${esc(item.moradorNome)}</strong><br>Endereço: ${esc(item.moradorCasa)}<br>Entrada: ${esc(item.dataEntrada || '-')} ${item.dataRetirada ? '<br>Retirada: '+esc(item.dataRetirada) : ''}</div>
    ${item.observacao ? `<div class="meta">Observação: ${esc(item.observacao)}</div>` : ''}
    ${pinAction ? `<div class="actions">${pinAction}<span class="meta">${item.pinAtivo ? 'PIN ativo' : 'Você pode solicitar o PIN.'}</span></div>` : ''}
  </div>`;
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
    const pending = packages.filter(p => p.status === 'pendente');
    const history = packages.filter(p => p.status !== 'pendente');
    $('pendingList').innerHTML = pending.map(packageHtml).join('') || '<div class="empty">Nenhuma encomenda aguardando retirada.</div>';
    $('historyList').innerHTML = history.map(packageHtml).join('') || '<div class="empty">Ainda não há histórico de retiradas.</div>';
    document.querySelectorAll('[data-pin]').forEach(btn => btn.addEventListener('click', () => resendPin(btn.dataset.pin, btn)));
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
