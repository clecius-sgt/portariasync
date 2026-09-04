'use strict';

const DEFAULT_POLICY = {
  enabled:true, reminder1Hours:24, reminder2Hours:72, attentionHours:120, criticalHours:168,
  minGapHours:20, retryHours:6, sendWindowStart:8, sendWindowEnd:20, timezoneOffsetMinutes:-180, adminWhatsApp:''
};
const SUCCESS_EVENT = 'automatic_package_alert';
let authToken = localStorage.getItem('authToken') || '';
let currentState = null;
let currentUser = null;

function api(path, options = {}) {
  const headers = { 'Content-Type':'application/json', ...(options.headers || {}) };
  if (authToken) headers.Authorization = 'Bearer ' + authToken;
  return fetch(path, { ...options, headers }).then(async response => {
    let payload = null;
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(payload?.error || payload?.detail || `HTTP ${response.status}`);
    return payload;
  });
}

function showMessage(text, type='ok') {
  const el = document.getElementById('message');
  el.className = type;
  el.textContent = text;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}

function parseDate(value) {
  if (!value) return null;
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct;
  const match = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;
  const [, d,m,y,hh='0',mm='0',ss='0'] = match;
  const date = new Date(Number(y), Number(m)-1, Number(d), Number(hh), Number(mm), Number(ss));
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizePolicy(source = {}) {
  const p = { ...DEFAULT_POLICY, ...(source || {}) };
  p.enabled = source?.enabled !== false;
  for (const key of ['reminder1Hours','reminder2Hours','attentionHours','criticalHours','minGapHours','retryHours','sendWindowStart','sendWindowEnd','timezoneOffsetMinutes']) {
    const n = Number(p[key]);
    if (Number.isFinite(n)) p[key] = n;
  }
  p.adminWhatsApp = String(p.adminWhatsApp || '').replace(/\D/g,'');
  return p;
}

function ageHours(pkg) {
  const entry = parseDate(pkg?.dataEntrada);
  return entry ? Math.max(0,(Date.now()-entry.getTime())/3600000) : 0;
}

function levelFor(pkg, p) {
  const age = ageHours(pkg);
  if (age >= p.criticalHours) return 'critical';
  if (age >= p.attentionHours) return 'priority';
  if (age >= p.reminder2Hours) return 'attention';
  return 'normal';
}

function sentEvents(pkg) {
  return (pkg?.cadeiaCustodia || []).filter(event => event?.type === SUCCESS_EVENT);
}

function formatDate(value) {
  const date = parseDate(value);
  return date ? date.toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '-';
}

function levelLabel(level) {
  return ({normal:'NORMAL',attention:'ATENÇÃO',priority:'PRIORIDADE',critical:'CRÍTICO'})[level] || 'NORMAL';
}

function nextAction(pkg,p) {
  const entry = parseDate(pkg?.dataEntrada);
  if (!entry) return null;
  const sent = new Set(sentEvents(pkg).map(e => String(e?.metadata?.alertStage || '')).filter(Boolean));
  const defs = [
    ['resident-reminder-1',p.reminder1Hours],
    ['resident-reminder-2',p.reminder2Hours],
    ['admin-attention',p.attentionHours],
    ['admin-critical',p.criticalHours]
  ];
  const next = defs.find(([id]) => !sent.has(id));
  return next ? new Date(entry.getTime()+next[1]*3600000) : null;
}

function fillPolicy(p) {
  document.getElementById('enabled').checked = p.enabled;
  document.getElementById('reminder1').value = p.reminder1Hours;
  document.getElementById('reminder2').value = p.reminder2Hours;
  document.getElementById('attention').value = p.attentionHours;
  document.getElementById('critical').value = p.criticalHours;
  document.getElementById('minGap').value = p.minGapHours;
  document.getElementById('adminWhats').value = p.adminWhatsApp || '';
  document.getElementById('windowStart').value = p.sendWindowStart;
  document.getElementById('windowEnd').value = p.sendWindowEnd;
}

function formPolicy() {
  const p = normalizePolicy({
    enabled:document.getElementById('enabled').checked,
    reminder1Hours:Number(document.getElementById('reminder1').value),
    reminder2Hours:Number(document.getElementById('reminder2').value),
    attentionHours:Number(document.getElementById('attention').value),
    criticalHours:Number(document.getElementById('critical').value),
    minGapHours:Number(document.getElementById('minGap').value),
    sendWindowStart:Number(document.getElementById('windowStart').value),
    sendWindowEnd:Number(document.getElementById('windowEnd').value),
    adminWhatsApp:document.getElementById('adminWhats').value,
    retryHours:6,
    timezoneOffsetMinutes:-180
  });
  if (!(p.reminder1Hours < p.reminder2Hours && p.reminder2Hours < p.attentionHours && p.attentionHours < p.criticalHours)) {
    throw new Error('Os marcos devem estar em ordem crescente: 1º lembrete, 2º lembrete, prioridade e crítico.');
  }
  if (!(p.sendWindowStart >= 0 && p.sendWindowStart < p.sendWindowEnd && p.sendWindowEnd <= 24)) {
    throw new Error('A janela de envio informada é inválida.');
  }
  return p;
}

async function saveWholeState(mutator) {
  const fresh = await api('/api/app-state');
  const changed = JSON.parse(JSON.stringify(fresh));
  delete changed.associacao;
  changed.configPublica = changed.configPublica && typeof changed.configPublica === 'object' ? changed.configPublica : {};
  mutator(changed);
  changed.version = Date.now();
  changed.updatedAt = new Date().toISOString();
  await api('/api/app-state',{method:'PUT',body:JSON.stringify(changed)});
  currentState = await api('/api/app-state');
  render();
}

async function savePolicy() {
  try {
    const p = formPolicy();
    await saveWholeState(state => { state.configPublica.packageAlertsPolicy = p; });
    showMessage('Política de alertas salva para esta associação.');
  } catch (error) {
    showMessage(error.message,'error');
  }
}

async function toggleSuspension(packageId, suspend) {
  try {
    let reason = '';
    if (suspend) {
      reason = prompt('Informe o motivo da suspensão dos alertas desta encomenda:') || '';
      if (reason.trim().length < 3) return showMessage('Informe um motivo para suspender os alertas.','error');
    }
    await saveWholeState(state => {
      const map = state.configPublica.packageAlertsSuspended && typeof state.configPublica.packageAlertsSuspended === 'object'
        ? state.configPublica.packageAlertsSuspended : {};
      if (suspend) {
        map[String(packageId)] = { suspended:true, reason:reason.trim().slice(0,180), at:new Date().toISOString(), by:currentUser?.nome || 'Administrador' };
      } else {
        delete map[String(packageId)];
      }
      state.configPublica.packageAlertsSuspended = map;
    });
    showMessage(suspend ? 'Alertas suspensos para a encomenda.' : 'Alertas reativados para a encomenda.');
  } catch (error) {
    showMessage(error.message,'error');
  }
}

function render() {
  const state = currentState || {};
  const p = normalizePolicy(state.configPublica?.packageAlertsPolicy || {});
  fillPolicy(p);
  const suspended = state.configPublica?.packageAlertsSuspended || {};
  const pending = (state.encomendas || []).filter(pkg => pkg.status === 'pendente');
  const counts = {normal:0,attention:0,priority:0,critical:0};
  for (const pkg of pending) counts[levelFor(pkg,p)]++;
  document.getElementById('nNormal').textContent = counts.normal;
  document.getElementById('nAttention').textContent = counts.attention;
  document.getElementById('nPriority').textContent = counts.priority;
  document.getElementById('nCritical').textContent = counts.critical;

  const list = document.getElementById('packageList');
  if (!pending.length) {
    list.innerHTML = '<div class="desc">Nenhuma encomenda aguardando retirada.</div>';
    return;
  }
  pending.sort((a,b) => ageHours(b)-ageHours(a));
  list.innerHTML = pending.map(pkg => {
    const level = levelFor(pkg,p);
    const days = Math.floor(ageHours(pkg)/24);
    const events = sentEvents(pkg);
    const last = events.at(-1);
    const next = nextAction(pkg,p);
    const record = suspended[String(pkg.id)];
    const isSuspended = record?.suspended === true;
    return `<div class="pkg"><div><div class="pkg-title">${escapeHtml(pkg.moradorNome || 'Morador')} · ${escapeHtml(pkg.codigo || '-')}</div><div class="pkg-meta">${escapeHtml(pkg.moradorCasa || '')}<br>Aguardando há ${days} dia(s) · Última ação automática: ${last ? formatDate(last.occurredAt || last.recordedAt) : 'nenhuma'}<br>Próxima ação prevista: ${next ? formatDate(next) : 'sem nova ação'}${isSuspended ? `<br><strong>Suspenso:</strong> ${escapeHtml(record.reason || '')}` : ''}</div></div><div style="text-align:right"><span class="badge ${level}">${levelLabel(level)}</span><div style="margin-top:8px"><button class="smallbtn ${isSuspended?'resume':'suspend'}" onclick="toggleSuspension('${escapeAttr(pkg.id)}',${isSuspended?'false':'true'})">${isSuspended?'Reativar':'Suspender'}</button></div></div></div>`;
  }).join('');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(value){ return String(value ?? '').replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }

async function refresh() {
  try {
    currentState = await api('/api/app-state');
    render();
  } catch (error) {
    showMessage('Não foi possível atualizar: '+error.message,'error');
  }
}

async function init() {
  const gate = document.getElementById('gate');
  try {
    if (!authToken) throw new Error('Entre primeiro no PortalSync como administrador.');
    const session = await api('/api/auth/me');
    currentUser = session.user;
    if (currentUser?.perfil !== 'admin') throw new Error('Esta configuração é restrita ao perfil administrador.');
    currentState = await api('/api/app-state');
    gate.style.display = 'none';
    document.getElementById('content').style.display = 'block';
    render();
  } catch (error) {
    document.getElementById('gateText').textContent = error.message;
  }
}

document.getElementById('saveBtn').addEventListener('click',savePolicy);
document.getElementById('refreshBtn').addEventListener('click',refresh);
window.toggleSuspension = toggleSuspension;
init();
