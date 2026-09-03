(function(root) {
  'use strict';

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function parseDate(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === 'number') {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const raw = text(value);
    if (!raw) return null;
    const isoDay = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoDay) {
      const d = new Date(Number(isoDay[1]), Number(isoDay[2]) - 1, Number(isoDay[3]));
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const br = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (br) {
      const d = new Date(Number(br[3]), Number(br[2]) - 1, Number(br[1]), Number(br[4] || 0), Number(br[5] || 0), Number(br[6] || 0));
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function entryDate(pkg) {
    return parseDate(pkg?.dataEntrada || pkg?.entradaEm || pkg?.recebidaEm || pkg?.createdAt || pkg?.created_at || pkg?.data || pkg?.dataCadastro);
  }

  function withdrawalDate(pkg) {
    return parseDate(pkg?.dataRetirada || pkg?.retiradaEm || pkg?.retiradoEm || pkg?.withdrawalAt || pkg?.withdrawal_at);
  }

  function statusOf(pkg) {
    const value = text(pkg?.status).toLowerCase();
    if (/retir|entreg|finaliz/.test(value) || withdrawalDate(pkg)) return 'retirado';
    if (/cancel|exclu/.test(value)) return 'cancelado';
    return 'pendente';
  }

  function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function endOfDay(date) {
    const d = new Date(date);
    d.setHours(23, 59, 59, 999);
    return d;
  }

  function resolvePeriod(options = {}, now = new Date()) {
    const mode = text(options.mode || options.period || '30');
    let start;
    let end = endOfDay(parseDate(options.end) || now);
    if (mode === 'custom') {
      start = startOfDay(parseDate(options.start) || now);
      end = endOfDay(parseDate(options.end) || now);
    } else if (mode === 'today') {
      start = startOfDay(now);
    } else {
      const days = Math.max(1, Math.min(3660, Number(mode) || Number(options.days) || 30));
      start = startOfDay(now);
      start.setDate(start.getDate() - (days - 1));
    }
    if (start > end) [start, end] = [startOfDay(end), endOfDay(start)];
    return { start, end };
  }

  function inRange(date, period) {
    return !!date && date.getTime() >= period.start.getTime() && date.getTime() <= period.end.getTime();
  }

  function hoursBetween(a, b) {
    if (!a || !b) return null;
    const hours = (b.getTime() - a.getTime()) / 3600000;
    return Number.isFinite(hours) && hours >= 0 ? hours : null;
  }

  function median(values) {
    const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!sorted.length) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function residentMap(state) {
    return new Map((Array.isArray(state?.moradores) ? state.moradores : []).filter(Boolean).map(item => [text(item.id), item]));
  }

  function packageResident(pkg, residents) {
    const linked = residents.get(text(pkg?.moradorId || pkg?.residentId || pkg?.resident_id));
    return {
      id: text(pkg?.moradorId || pkg?.residentId || pkg?.resident_id || linked?.id),
      name: text(pkg?.moradorNome || pkg?.residentName || pkg?.resident_name || linked?.nome || pkg?.morador),
      house: text(pkg?.moradorCasa || pkg?.residentHouse || pkg?.resident_house || linked?.casa)
    };
  }

  function carrierOf(pkg) {
    return text(pkg?.transportadora || pkg?.carrier || pkg?.remetente || 'Não informada') || 'Não informada';
  }

  function codeOf(pkg) {
    return text(pkg?.codigo || pkg?.code || pkg?.rastreio || pkg?.tracking || pkg?.id);
  }

  function countBy(items, keyFn, limit = 10) {
    const map = new Map();
    for (const item of items) {
      const key = text(keyFn(item)) || 'Não informado';
      map.set(key, Number(map.get(key) || 0) + 1);
    }
    return Array.from(map, ([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'pt-BR'))
      .slice(0, limit);
  }

  function dayKey(date) {
    if (!date) return '';
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function dailySeries(items, period, dateFn) {
    const map = new Map();
    for (const item of items) {
      const date = dateFn(item);
      if (!inRange(date, period)) continue;
      const key = dayKey(date);
      map.set(key, Number(map.get(key) || 0) + 1);
    }
    const out = [];
    const cursor = startOfDay(period.start);
    while (cursor <= period.end) {
      const key = dayKey(cursor);
      out.push({ date: key, count: Number(map.get(key) || 0) });
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }

  function pendingAgeBucket(hours) {
    if (!Number.isFinite(hours)) return 'Sem data';
    if (hours < 24) return 'Até 24h';
    if (hours < 72) return '1 a 3 dias';
    if (hours < 168) return '3 a 7 dias';
    return 'Mais de 7 dias';
  }

  function ocrSummary(state, period) {
    const events = Array.isArray(state?.configPublica?.metricasOcr?.events) ? state.configPublica.metricasOcr.events : [];
    const filtered = events.filter(event => inRange(parseDate(event?.at), period));
    const total = filtered.length;
    const pct = count => total ? Math.round(count * 1000 / total) / 10 : 0;
    const address = filtered.filter(event => event?.addressResolved).length;
    const fallback = filtered.filter(event => event?.fallbackUsed || event?.route === 'server-fallback').length;
    const failed = filtered.filter(event => event?.failed || event?.route === 'failed').length;
    const elapsed = filtered.map(event => Number(event?.elapsedMs)).filter(value => Number.isFinite(value) && value >= 0);
    return {
      total,
      addressRate: pct(address),
      fallbackRate: pct(fallback),
      failureRate: pct(failed),
      avgElapsedMs: elapsed.length ? Math.round(elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length) : null
    };
  }

  function build(state, options = {}, nowInput = new Date()) {
    const now = parseDate(nowInput) || new Date();
    const period = resolvePeriod(options, now);
    const residents = residentMap(state);
    const packages = (Array.isArray(state?.encomendas) ? state.encomendas : []).filter(Boolean);

    const received = packages.filter(pkg => inRange(entryDate(pkg), period));
    const withdrawn = packages.filter(pkg => statusOf(pkg) === 'retirado' && inRange(withdrawalDate(pkg), period));
    const pending = packages.filter(pkg => statusOf(pkg) === 'pendente');
    const cancelled = packages.filter(pkg => statusOf(pkg) === 'cancelado' && inRange(entryDate(pkg), period));

    const withdrawalHours = withdrawn.map(pkg => hoursBetween(entryDate(pkg), withdrawalDate(pkg))).filter(Number.isFinite);
    const avgPickupHours = withdrawalHours.length ? withdrawalHours.reduce((sum, value) => sum + value, 0) / withdrawalHours.length : null;
    const medianPickupHours = median(withdrawalHours);
    const sameDay = withdrawalHours.filter(value => value <= 24).length;
    const sameDayRate = withdrawalHours.length ? Math.round(sameDay * 1000 / withdrawalHours.length) / 10 : 0;

    const pendingRows = pending.map(pkg => {
      const resident = packageResident(pkg, residents);
      const entered = entryDate(pkg);
      const ageHours = entered ? hoursBetween(entered, now) : null;
      return {
        id: text(pkg.id),
        code: codeOf(pkg),
        resident: resident.name || 'Não informado',
        house: resident.house || 'Não informado',
        carrier: carrierOf(pkg),
        entryAt: entered ? entered.toISOString() : null,
        ageHours,
        ageBucket: pendingAgeBucket(ageHours)
      };
    }).sort((a, b) => (b.ageHours ?? -1) - (a.ageHours ?? -1));

    const pendingBucketsOrder = ['Até 24h', '1 a 3 dias', '3 a 7 dias', 'Mais de 7 dias', 'Sem data'];
    const pendingMap = new Map(pendingBucketsOrder.map(label => [label, 0]));
    pendingRows.forEach(row => pendingMap.set(row.ageBucket, Number(pendingMap.get(row.ageBucket) || 0) + 1));
    const pendingAging = pendingBucketsOrder.map(label => ({ label, count: pendingMap.get(label) || 0 }));

    const receivedDecorated = received.map(pkg => ({ pkg, resident: packageResident(pkg, residents) }));
    const withdrawnRows = withdrawn.map(pkg => {
      const resident = packageResident(pkg, residents);
      const entered = entryDate(pkg);
      const removed = withdrawalDate(pkg);
      return {
        id: text(pkg.id),
        code: codeOf(pkg),
        resident: resident.name || 'Não informado',
        house: resident.house || 'Não informado',
        carrier: carrierOf(pkg),
        entryAt: entered ? entered.toISOString() : null,
        withdrawalAt: removed ? removed.toISOString() : null,
        pickupHours: hoursBetween(entered, removed)
      };
    }).sort((a, b) => String(b.withdrawalAt || '').localeCompare(String(a.withdrawalAt || '')));

    return {
      generatedAt: now.toISOString(),
      period: { start: period.start.toISOString(), end: period.end.toISOString() },
      totals: {
        residents: residents.size,
        packagesStored: packages.length,
        received: received.length,
        withdrawn: withdrawn.length,
        pending: pending.length,
        cancelled: cancelled.length,
        pendingOver48h: pendingRows.filter(row => Number.isFinite(row.ageHours) && row.ageHours >= 48).length,
        avgPickupHours,
        medianPickupHours,
        sameDayRate
      },
      dailyReceived: dailySeries(packages, period, entryDate),
      carriers: countBy(received, carrierOf, 10),
      residents: countBy(receivedDecorated, item => item.resident.name || 'Não informado', 10),
      pendingAging,
      pendingRows: pendingRows.slice(0, 100),
      withdrawals: withdrawnRows.slice(0, 100),
      ocr: ocrSummary(state, period)
    };
  }

  const api = { parseDate, entryDate, withdrawalDate, statusOf, resolvePeriod, hoursBetween, build };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ManagerialReports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
