(function(){
'use strict';
const API_BASE = localStorage.getItem('apiBaseUrl') || '';
const ASSOCIATION_STATE_KEYS=['moradores','encomendas','retirantesRelacionados','auditoria','memoriaRemetentes','config','detalhesRetirada','estadoServidorVersion','ultimaSincronizacaoOk','resetEncomendasAplicado'];
let token = localStorage.getItem('authToken') || '';
let currentAssociationId = '';
const $ = id => document.getElementById(id);

function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function slug(value){return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,48);}
function applyAssociationScope(id){
  const target=String(id||'').trim(); if(!target) return false;
  const current=String(localStorage.getItem('activeAssociationId')||'');
  if(current===target) return false;
  ASSOCIATION_STATE_KEYS.forEach(key=>localStorage.removeItem(key));
  localStorage.setItem('activeAssociationId',target);
  return true;
}
async function api(path, options={}){
  const headers={...(options.headers||{})};
  if(options.body&&!headers['Content-Type']) headers['Content-Type']='application/json';
  if(token) headers.Authorization='Bearer '+token;
  const response=await fetch(API_BASE+path,{...options,headers});
  let data={}; try{data=await response.json();}catch(_){}
  if(!response.ok){const e=new Error(data.error||data.detail||('Erro HTTP '+response.status));e.status=response.status;throw e;}
  return data;
}
function countsText(item){
  const c=item?.database?.counts||{};
  if(item?.database?.integrity==='error') return 'Banco indisponível para leitura.';
  return `Moradores: ${Number(c.residents||0)}<br>Encomendas: ${Number(c.packages||0)}<br>Auditoria: ${Number(c.audit||0)}`;
}
function portalUrl(id){return location.origin+'/morador.html?associacao='+encodeURIComponent(id);}
function render(items){
  $('associationGrid').innerHTML=(items||[]).map(item=>{
    const current=item.id===currentAssociationId;
    return `<article class="card assoc ${current?'current':''}">
      <h3>${esc(item.nome)}${current?'<span class="current-mark">EM USO</span>':''}</h3>
      <div class="meta">ID: ${esc(item.id)}</div>
      <span class="badge">${item.active?'ATIVA':'INATIVA'}</span>
      <div class="counts">${countsText(item)}</div>
      <div class="actions">
        <button class="primary" data-switch="${esc(item.id)}" ${current?'disabled':''}>${current?'Associação atual':'Operar nesta associação'}</button>
        <button class="light" data-copy="${esc(portalUrl(item.id))}">Copiar portal do morador</button>
      </div>
    </article>`;
  }).join('')||'<div class="card">Nenhuma associação cadastrada.</div>';
  document.querySelectorAll('[data-switch]').forEach(btn=>btn.addEventListener('click',()=>switchAssociation(btn.dataset.switch,btn)));
  document.querySelectorAll('[data-copy]').forEach(btn=>btn.addEventListener('click',()=>copyPortal(btn.dataset.copy,btn)));
}
async function load(){
  if(!token){location.href='/admin.html';return;}
  try{
    const me=await api('/api/auth/me');
    if(!me.user?.plataforma){throw new Error('Acesso restrito ao administrador da plataforma.');}
    currentAssociationId=me.user.associacaoId||'principal';
    applyAssociationScope(currentAssociationId);
    $('currentAssociation').textContent='Operando em: '+(me.user.associacaoNome||currentAssociationId);
    const data=await api('/api/associations');
    render(data.multiAssociation?.associations||[]);
  }catch(error){
    $('message').textContent=error.message;
    if(error.status===403) setTimeout(()=>location.href='/admin.html',1200);
  }
}
async function createAssociation(){
  const name=$('associationName').value.trim();
  const id=slug($('associationId').value||name);
  if(name.length<3||id.length<3){$('message').textContent='Informe um nome e um identificador válidos.';return;}
  const button=$('createButton');button.disabled=true;$('message').textContent='Criando associação...';
  try{
    const data=await api('/api/associations',{method:'POST',body:JSON.stringify({nome:name,id})});
    $('message').textContent='Associação criada: '+data.association.nome+'.';
    $('associationName').value='';$('associationId').value='';
    await load();
  }catch(error){$('message').textContent=error.message;}finally{button.disabled=false;}
}
async function switchAssociation(id,button){
  button.disabled=true;
  try{
    const data=await api('/api/auth/switch-association',{method:'POST',body:JSON.stringify({associacaoId:id})});
    currentAssociationId=data.user?.associacaoId||id;
    applyAssociationScope(currentAssociationId);
    $('currentAssociation').textContent='Operando em: '+(data.user?.associacaoNome||id);
    $('message').textContent='Contexto alterado. O sistema e os relatórios agora usam somente esta associação.';
    await load();
  }catch(error){$('message').textContent=error.message;}finally{button.disabled=false;}
}
async function copyPortal(url,button){
  try{await navigator.clipboard.writeText(url);const old=button.textContent;button.textContent='Link copiado';setTimeout(()=>button.textContent=old,1400);}catch(_){prompt('Copie o endereço do Portal do Morador:',url);}
}
$('associationName').addEventListener('input',()=>{if(!$('associationId').dataset.manual)$('associationId').value=slug($('associationName').value);});
$('associationId').addEventListener('input',()=>{$('associationId').dataset.manual='1';$('associationId').value=slug($('associationId').value);});
$('createButton').addEventListener('click',createAssociation);
load();
})();
