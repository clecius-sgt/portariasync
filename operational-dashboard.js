'use strict';

const { normalizePolicy, levelForAge } = require('./package-alert-service');

function text(value, fallback = '') {
  const result = String(value == null ? '' : value).trim();
  return result || fallback;
}

function statusOf(item) {
  const status = text(item?.status).toLowerCase();
  if (/retir|entreg|finaliz/.test(status) || item?.dataRetirada || item?.withdrawalAt) return 'retirado';
  if (/cancel|exclu/.test(status)) return 'cancelado';
  return 'pendente';
}

function clampOffset(value, fallback = -180) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(-720, Math.min(840, Math.round(parsed)));
}

function parseBusinessDate(value, offsetMinutes = -180) {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  const raw = text(value);
  const br = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (br) {
    const localUtc = Date.UTC(Number(br[3]), Number(br[2]) - 1, Number(br[1]), Number(br[4] || 0), Number(br[5] || 0), Number(br[6] || 0));
    const date = new Date(localUtc - clampOffset(offsetMinutes) * 60000);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  const isoLocal = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (isoLocal) {
    const localUtc = Date.UTC(Number(isoLocal[1]), Number(isoLocal[2]) - 1, Number(isoLocal[3]), Number(isoLocal[4] || 0), Number(isoLocal[5] || 0), Number(isoLocal[6] || 0));
    return new Date(localUtc - clampOffset(offsetMinutes) * 60000);
  }
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date : null;
}

function localParts(date, offsetMinutes) {
  if (!date) return null;
  const shifted = new Date(date.getTime() + clampOffset(offsetMinutes) * 60000);
  return {
    day: `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`,
    hour: shifted.getUTCHours()
  };
}

function entryValue(item) {
  return item?.dataEntrada || item?.entradaEm || item?.entryAt || item?.createdAt || item?.created_at || item?.data;
}

function withdrawalValue(item) {
  return item?.dataRetirada || item?.retiradaEm || item?.withdrawalAt || item?.withdrawnAt;
}

function residentMap(state) {
  return new Map((Array.isArray(state?.moradores) ? state.moradores : []).filter(Boolean).map(item => [text(item.id), item]));
}

function packageResident(item, residents) {
  const linked = residents.get(text(item?.moradorId || item?.residentId || item?.resident_id));
  return {
    name: text(item?.moradorNome || item?.residentName || item?.resident_name || linked?.nome, 'Não informado'),
    house: text(item?.moradorCasa || item?.residentHouse || item?.resident_house || linked?.casa, 'Não informado')
  };
}

function ageHours(date, now) {
  if (!date) return null;
  const hours = (now.getTime() - date.getTime()) / 3600000;
  return Number.isFinite(hours) ? Math.max(0, hours) : null;
}

function priorityLabel(level) {
  return ({ critical: 'Crítica', priority: 'Prioritária', attention: 'Atenção', normal: 'Normal' })[level] || 'Normal';
}

function build(state = {}, options = {}) {
  const now = parseBusinessDate(options.now) || new Date();
  const policy = normalizePolicy(state?.configPublica?.packageAlertsPolicy || {});
  const offsetMinutes = clampOffset(options.timezoneOffsetMinutes, policy.timezoneOffsetMinutes);
  const today = localParts(now, offsetMinutes).day;
  const residents = residentMap(state);
  const packages = (Array.isArray(state.encomendas) ? state.encomendas : []).filter(Boolean);
  const pendingItems = packages.filter(item => statusOf(item) === 'pendente');

  const queue = pendingItems.map(item => {
    const entered = parseBusinessDate(entryValue(item), offsetMinutes);
    const hours = ageHours(entered, now);
    const level = Number.isFinite(hours) ? levelForAge(hours, policy) : 'normal';
    const resident = packageResident(item, residents);
    return {
      id: text(item.id),
      code: text(item.codigo || item.code || item.rastreio || item.id, 'Sem código'),
      resident: resident.name,
      house: resident.house,
      carrier: text(item.transportadora || item.carrier || item.remetente, 'Não informada'),
      entryAt: entered ? entered.toISOString() : null,
      ageHours: hours,
      level,
      priority: priorityLabel(level)
    };
  }).sort((a, b) => (b.ageHours ?? -1) - (a.ageHours ?? -1));

  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, received: 0, withdrawn: 0 }));
  const recent = [];
  let receivedToday = 0;
  let withdrawnToday = 0;
  for (const item of packages) {
    const resident = packageResident(item, residents);
    const entered = parseBusinessDate(entryValue(item), offsetMinutes);
    const entryParts = localParts(entered, offsetMinutes);
    if (entryParts?.day === today) {
      receivedToday += 1;
      hourly[entryParts.hour].received += 1;
      recent.push({
        type: 'received',
        occurredAt: entered.toISOString(),
        resident: resident.name,
        house: resident.house,
        code: text(item.codigo || item.code || item.id, 'Sem código')
      });
    }
    const withdrawn = parseBusinessDate(withdrawalValue(item), offsetMinutes);
    const withdrawalParts = localParts(withdrawn, offsetMinutes);
    if (withdrawalParts?.day === today && statusOf(item) === 'retirado') {
      withdrawnToday += 1;
      hourly[withdrawalParts.hour].withdrawn += 1;
      recent.push({
        type: 'withdrawn',
        occurredAt: withdrawn.toISOString(),
        resident: resident.name,
        house: resident.house,
        code: text(item.codigo || item.code || item.id, 'Sem código')
      });
    }
  }
  recent.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  const aging = [
    { id: 'normal', label: `Menos de ${policy.reminder2Hours}h`, count: queue.filter(item => item.level === 'normal').length },
    { id: 'attention', label: `${policy.reminder2Hours}h a ${policy.attentionHours - 1}h`, count: queue.filter(item => item.level === 'attention').length },
    { id: 'priority', label: `${policy.attentionHours}h a ${policy.criticalHours - 1}h`, count: queue.filter(item => item.level === 'priority').length },
    { id: 'critical', label: `${policy.criticalHours}h ou mais`, count: queue.filter(item => item.level === 'critical').length }
  ];

  const occurrenceStatus = options.occurrences || {};
  const whatsapp = options.whatsapp || {};
  const paddle = options.paddleocr || {};
  const alerts = [];
  const critical = queue.filter(item => item.level === 'critical').length;
  const priority = queue.filter(item => item.level === 'priority').length;
  if (critical) alerts.push({ level: 'critical', title: `${critical} encomenda(s) em situação crítica`, detail: `Aguardando há ${policy.criticalHours} horas ou mais.` });
  if (priority) alerts.push({ level: 'priority', title: `${priority} encomenda(s) prioritária(s)`, detail: `Aguardando há ${policy.attentionHours} horas ou mais.` });
  if (Number(occurrenceStatus.critical || 0) > 0) alerts.push({ level: 'critical', title: `${occurrenceStatus.critical} ocorrência(s) crítica(s)`, detail: 'Exigem acompanhamento da administração.' });
  if (whatsapp.configured === false) alerts.push({ level: 'attention', title: 'WhatsApp indisponível', detail: 'Os avisos aos moradores não podem ser enviados.' });
  if (paddle.installed === false) alerts.push({ level: 'attention', title: 'Leitor OCR não instalado', detail: 'A leitura assistida de etiquetas está indisponível.' });
  if (paddle.lastError) alerts.push({ level: 'attention', title: 'Falha recente no leitor OCR', detail: text(paddle.lastError).slice(0, 180) });

  return {
    generatedAt: now.toISOString(),
    timezoneOffsetMinutes: offsetMinutes,
    association: options.association || null,
    summary: {
      receivedToday,
      withdrawnToday,
      pending: queue.length,
      priority: priority + critical,
      critical,
      oldestPendingHours: queue[0]?.ageHours ?? null,
      openOccurrences: Number(occurrenceStatus.opened || 0) + Number(occurrenceStatus.inProgress || 0)
    },
    serviceStatus: {
      database: options.database?.ready === true,
      whatsapp: whatsapp.configured === true,
      ocr: paddle.installed === true,
      ocrReady: paddle.ready === true,
      alertsEnabled: policy.enabled
    },
    policy: {
      attentionHours: policy.attentionHours,
      criticalHours: policy.criticalHours
    },
    hourly,
    aging,
    alerts,
    queue: queue.slice(0, 100),
    recent: recent.slice(0, 20)
  };
}

module.exports = { build, parseBusinessDate, localParts, statusOf, clampOffset };
