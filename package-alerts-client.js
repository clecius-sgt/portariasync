(function(root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PackageAlertsUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';

  const VERSION = '2026-09-04.1';
  const SUCCESS_EVENT = 'automatic_package_alert';
  const DEFAULT_POLICY = {
    enabled:true, reminder1Hours:24, reminder2Hours:72, attentionHours:120, criticalHours:168,
    minGapHours:20, retryHours:6, sendWindowStart:8, sendWindowEnd:20, timezoneOffsetMinutes:-180, adminWhatsApp:''
  };
  let snapshot = { policy: DEFAULT_POLICY, suspended:{}, packages:{} };
  let timer = null;

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function num(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function policy(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      ...DEFAULT_POLICY,
      ...source,
      enabled: source.enabled !== false,
      reminder1Hours: num(source.reminder1Hours, 24),
      reminder2Hours: num(source.reminder2Hours, 72),
      attentionHours: num(source.attentionHours, 120),
      criticalHours: num(source.criticalHours, 168),
      minGapHours: num(source.minGapHours, 20),
      timezoneOffsetMinutes: num(source.timezoneOffsetMinutes, -180)
    };
  }

  function parseDate(value) {
    if (!value) return null;
    const direct = new Date(value);
    if (!Number.isNaN(direct.getTime())) return direct;
    const match = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!match) return null;
    const [, d, m, y, hh='0', mm='0', ss='0'] = match;
    const parsed = new Date(Number(y), Number(m)-1, Number(d), Number(hh), Number(mm), Number(ss));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function ageHours(pkg, now = new Date()) {
    const entry = parseDate(pkg?.dataEntrada);
    return entry ? Math.max(0, (now-entry)/3600000) : 0;
  }

  function level(age, p) {
    if (age >= p.criticalHours) return 'critical';
    if (age >= p.attentionHours) return 'priority';
    if (age >= p.reminder2Hours) return 'attention';
    return 'normal';
  }

  function stageDefs(p) {
    return [
      {id:'resident-reminder-1', hours:p.reminder1Hours},
      {id:'resident-reminder-2', hours:p.reminder2Hours},
      {id:'admin-attention', hours:p.attentionHours},
      {id:'admin-critical', hours:p.criticalHours}
    ];
  }

  function sentStages(pkg) {
    const stages = new Set();
    for (const event of Array.isArray(pkg?.cadeiaCustodia) ? pkg.cadeiaCustodia : []) {
      if (event?.type !== SUCCESS_EVENT) continue;
      const stage = String(event?.metadata?.alertStage || '');
      if (stage) stages.add(stage);
    }
    return stages;
  }

  function lastAction(pkg) {
    const events = (Array.isArray(pkg?.cadeiaCustodia) ? pkg.cadeiaCustodia : []).filter(event => event?.type === SUCCESS_EVENT);
    return events.at(-1) || null;
  }

  function nextAction(pkg, p, suspended, now = new Date()) {
    if (!p.enabled || pkg?.status !== 'pendente' || suspended) return null;
    const entry = parseDate(pkg.dataEntrada);
    if (!entry) return null;
    const sent = sentStages(pkg);
    const next = stageDefs(p).find(item => !sent.has(item.id));
    if (!next) return null;
    const date = new Date(entry.getTime() + next.hours * 3600000);
    return date < now ? now : date;
  }

  function formatDate(value) {
    const date = value instanceof Date ? value : parseDate(value);
    if (!date) return '-';
    return date.toLocaleString('pt-BR', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
  }

  function levelMeta(value) {
    if (value === 'critical') return { label:'CRÍTICO', bg:'#fce8e6', color:'#b42318' };
    if (value === 'priority') return { label:'PRIORIDADE', bg:'#fff3cd', color:'#856404' };
    if (value === 'attention') return { label:'ATENÇÃO', bg:'#fff8e1', color:'#9a6700' };
    return { label:'NORMAL', bg:'#e6f4ea', color:'#137333' };
  }

  function packageView(pkg, state, now = new Date()) {
    const p = policy(state?.configPublica?.packageAlertsPolicy);
    const suspendedRecord = state?.configPublica?.packageAlertsSuspended?.[String(pkg?.id || '')];
    const suspended = suspendedRecord?.suspended === true;
    const age = ageHours(pkg, now);
    const latest = lastAction(pkg);
    return {
      level: level(age, p),
      ageHours: age,
      ageDays: Math.floor(age/24),
      lastActionAt: latest?.occurredAt || latest?.recordedAt || null,
      nextActionAt: nextAction(pkg, p, suspended, now),
      suspended,
      enabled: p.enabled
    };
  }

  function statusHtml(id) {
    const data = snapshot.packages[String(id || '')];
    if (!data) return '';
    if (!data.enabled) return '<div class="data" style="margin-top:7px;color:#64748b;">⏱️ Alertas automáticos desativados para esta associação</div>';
    if (data.suspended) return '<div class="data" style="margin-top:7px;color:#856404;font-weight:700;">⏸️ Alertas automáticos suspensos para esta encomenda</div>';
    const meta = levelMeta(data.level);
    const waiting = data.ageDays > 0 ? ` · aguardando ${data.ageDays} dia(s)` : '';
    const last = data.lastActionAt ? ` · último aviso ${formatDate(data.lastActionAt)}` : '';
    const next = data.nextActionAt ? ` · próxima ação ${formatDate(data.nextActionAt)}` : '';
    return `<div class="data" style="margin-top:7px;line-height:1.55;"><span style="display:inline-block;padding:3px 8px;border-radius:999px;background:${meta.bg};color:${meta.color};font-weight:800;font-size:10px;">${meta.label}</span>${waiting}${last}${next}</div>`;
  }

  function installConfigShortcut() {
    const doc = root?.document;
    const page = doc?.getElementById?.('page-config');
    if (!page || doc.getElementById('packageAlertsConfigShortcut')) return false;
    const card = doc.createElement('div');
    card.className = 'card';
    card.id = 'packageAlertsConfigShortcut';
    card.innerHTML = '<h2>Alertas inteligentes de permanência</h2><p style="color:var(--muted);font-size:13px;line-height:1.5;margin-bottom:12px;">Configure os lembretes automáticos, níveis de atenção e escalonamento para a administração.</p><a class="btn btn-primary" href="/alertas.html" style="text-decoration:none;">Configurar alertas</a>';
    page.appendChild(card);
    return true;
  }

  function rerender() {
    try { root?.renderDashboard?.(); } catch (_) {}
    try { root?.renderEncomendas?.(); } catch (_) {}
  }

  async function refresh() {
    if (typeof root?.apiFetch !== 'function') return false;
    try {
      const state = await root.apiFetch('/api/app-state');
      const p = policy(state?.configPublica?.packageAlertsPolicy);
      const suspended = state?.configPublica?.packageAlertsSuspended || {};
      const packages = {};
      for (const pkg of state?.encomendas || []) packages[String(pkg.id)] = packageView(pkg, state);
      snapshot = { policy:p, suspended, packages };
      rerender();
      return true;
    } catch (_) {
      return false;
    }
  }

  function install(host) {
    root = host || root;
    if (!root || root.__packageAlertsUiInstalled) return !!root;
    if (typeof root.itemEncomendaHTML !== 'function') {
      root.setTimeout?.(() => install(root), 300);
      return false;
    }
    root.__packageAlertsUiInstalled = true;
    const original = root.itemEncomendaHTML;
    root.itemEncomendaHTML = function(item) {
      const html = String(original.apply(this, arguments) || '');
      const status = statusHtml(item?.id);
      if (!status) return html;
      return html.replace(/<div class="actions">/, status + '<div class="actions">');
    };
    installConfigShortcut();
    refresh();
    timer = root.setInterval?.(() => refresh(), 5 * 60 * 1000) || null;
    return true;
  }

  function stop() {
    if (timer && root?.clearInterval) root.clearInterval(timer);
    timer = null;
  }

  return { VERSION, DEFAULT_POLICY, policy, parseDate, ageHours, level, sentStages, packageView, statusHtml, refresh, install, stop, version:VERSION };
});
