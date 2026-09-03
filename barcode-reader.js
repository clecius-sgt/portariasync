(function(root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.SeparateBarcodeReader = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const FORMATS = ['qr_code', 'data_matrix', 'pdf417', 'aztec', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf'];
  const STRUCTURED_KEYS = ['tracking', 'trackingcode', 'tracking_code', 'codigo', 'code', 'rastreio', 'id', 'shipmentid', 'shipment_id', 'packageid', 'package_id'];

  function canonicalFormat(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  }

  function typeForFormat(format) {
    format = canonicalFormat(format);
    if (format === 'qr_code') return 'qr';
    if (['data_matrix', 'pdf417', 'aztec'].includes(format)) return '2d';
    return 'barcode';
  }

  function exactTrackingToken(value) {
    const text = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
    return /^[A-Z]{2}\d{9,20}[A-Z]{1,2}$/.test(text) ? text : '';
  }

  function restoreTrailingSuffix(text, normalized) {
    const current = String(normalized || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!current) return current;
    const candidates = String(text || '').toUpperCase().match(/\b[A-Z]{2}\d{9,20}[A-Z]{1,2}\b/g) || [];
    const restored = candidates.find(code => code.startsWith(current) && code.length > current.length && code.length - current.length <= 2);
    return restored || current;
  }

  function looksLikeTracking(value) {
    const text = String(value || '').trim().replace(/\s+/g, '');
    if (!text || text.length < 6 || text.length > 64) return false;
    if (/^(?:TBR|TBA)\d{8,}$/i.test(text)) return true;
    if (/^[A-Z]{2}\d{9,20}[A-Z]{1,2}$/i.test(text)) return true;
    if (/^BR\d{8,20}[A-Z]{0,2}$/i.test(text)) return true;
    if (/^\d{8,40}$/.test(text)) return true;
    return /^[A-Z0-9][A-Z0-9._-]{5,63}$/i.test(text) && /\d/.test(text);
  }

  function strongTrackingPattern(value) {
    const text = String(value || '').trim().replace(/\s+/g, '').toUpperCase();
    return /^(?:TBR|TBA)\d{8,}$/.test(text)
      || /^[A-Z]{2}\d{9,20}[A-Z]{1,2}$/.test(text)
      || /^BR\d{8,20}[A-Z]{0,2}$/.test(text)
      || /^(?:SHP|RR|AA|RA|SB)[A-Z0-9]{6,}$/.test(text);
  }

  function objectValue(value) {
    if (!value || typeof value !== 'object') return '';
    const entries = Object.entries(value);
    for (const key of STRUCTURED_KEYS) {
      const found = entries.find(([name]) => String(name).toLowerCase() === key);
      if (found && (typeof found[1] === 'string' || typeof found[1] === 'number')) {
        const candidate = String(found[1]).trim();
        if (looksLikeTracking(candidate)) return candidate;
      }
    }
    for (const [, child] of entries) {
      if (child && typeof child === 'object') {
        const nested = objectValue(child);
        if (nested) return nested;
      }
    }
    return '';
  }

  function urlValue(raw) {
    const text = String(raw || '').trim();
    if (!/^https?:\/\//i.test(text)) return '';
    try {
      const parsed = new URL(text);
      for (const key of STRUCTURED_KEYS) {
        for (const [name, value] of parsed.searchParams.entries()) {
          if (String(name).toLowerCase() === key && looksLikeTracking(value)) return value;
        }
      }
      const segments = parsed.pathname.split('/').map(decodeURIComponent).filter(Boolean).reverse();
      return segments.find(looksLikeTracking) || '';
    } catch (_) {
      return '';
    }
  }

  function extractPayload(raw, format) {
    const text = String(raw || '').trim();
    if (!text) return '';
    const type = typeForFormat(format);
    if (type === 'qr' || type === '2d') {
      try {
        const parsed = JSON.parse(text);
        const found = objectValue(parsed);
        if (found) return found;
      } catch (_) {}
      const fromUrl = urlValue(text);
      if (fromUrl) return fromUrl;
      if (/^https?:\/\//i.test(text)) return '';
    }
    return text;
  }

  function normalizeCode(raw, format, host) {
    const payload = extractPayload(raw, format);
    if (!payload) return '';

    // Etiquetas de transportadoras podem terminar em uma ou duas letras. O normalizador
    // legado tinha uma regra BR + dígitos que cortava esse sufixo, como BR260699888470G.
    const exact = exactTrackingToken(payload);
    if (exact) return exact;

    let value = payload;
    try {
      if (host && typeof host.normalizarCodigoBarras === 'function') value = host.normalizarCodigoBarras(payload);
    } catch (_) {}
    value = restoreTrailingSuffix(payload, value);
    value = String(value || '').trim().replace(/\s+/g, '');
    if (!looksLikeTracking(value)) return '';
    return value;
  }

  function carrierForCode(code, host) {
    try {
      if (host && typeof host.detectarTransportadora === 'function') {
        return String(host.detectarTransportadora(code) || '').trim();
      }
    } catch (_) {}
    return '';
  }

  function structuredTrackingPayload(raw, format) {
    const text = String(raw || '').trim();
    if (!text || !['qr', '2d'].includes(typeForFormat(format))) return false;
    if (/^https?:\/\//i.test(text)) return !!urlValue(text);
    try { return !!objectValue(JSON.parse(text)); } catch (_) { return false; }
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || 0));
  }

  function score(raw, format, origin, host, meta = {}) {
    const code = normalizeCode(raw, format, host);
    if (!code) return -1;
    let value = 0;
    try {
      if (host && typeof host.pontuarCodigoBarras === 'function') {
        const external = Number(host.pontuarCodigoBarras(raw, canonicalFormat(format), origin));
        if (Number.isFinite(external)) value += clamp(external, -30, 80);
      }
    } catch (_) {}

    const carrier = carrierForCode(code, host);
    const strong = strongTrackingPattern(code);
    const structured = structuredTrackingPayload(raw, format);
    const numeric = /^\d+$/.test(code);
    const formatKey = canonicalFormat(format);

    if (carrier) value += 140;
    if (strong) value += 90;
    if (structured) value += 65;
    if (looksLikeTracking(code)) value += 25;
    if (typeForFormat(format) === 'qr') value += 8;
    if (/nativo/i.test(origin)) value += 6;
    value += clamp(meta.readability, 0, 35);

    if (!carrier && !strong && numeric && code.length >= 20) value -= 35;
    if (!carrier && !strong && /danfe/i.test(origin)) value -= 45;
    if (!carrier && !strong && /^(ean|upc)/.test(formatKey)) value -= 30;
    return value;
  }

  function candidate(raw, format, origin, host, meta = {}) {
    const codigo = normalizeCode(raw, format, host);
    if (!codigo) return null;
    const transportadora = carrierForCode(codigo, host);
    const rastreioForte = strongTrackingPattern(codigo);
    return {
      codigo,
      raw: String(raw || ''),
      formato: canonicalFormat(format) || 'unknown',
      tipo: typeForFormat(format),
      origem: origin,
      score: score(raw, format, origin, host, meta),
      legibilidade: clamp(meta.readability, 0, 35),
      transportadora,
      vinculoRemetente: !!transportadora || rastreioForte || structuredTrackingPayload(raw, format),
      rastreioForte,
      leitorSeparado: true
    };
  }

  function aggregateCandidates(candidates) {
    const groups = new Map();
    for (const item of (candidates || []).filter(Boolean)) {
      const key = String(item.codigo || '').toUpperCase();
      if (!key) continue;
      if (!groups.has(key)) {
        groups.set(key, {
          ...item,
          votosLeitura: 0,
          origensLeitura: [],
          formatosLidos: [],
          melhorScoreIndividual: Number(item.score || 0),
          legibilidade: Number(item.legibilidade || 0)
        });
      }
      const group = groups.get(key);
      group.votosLeitura += 1;
      if (!group.origensLeitura.includes(item.origem)) group.origensLeitura.push(item.origem);
      if (!group.formatosLidos.includes(item.formato)) group.formatosLidos.push(item.formato);
      group.legibilidade = Math.max(group.legibilidade, Number(item.legibilidade || 0));
      if (Number(item.score || 0) > group.melhorScoreIndividual) {
        const keepVotes = group.votosLeitura;
        const keepOrigins = group.origensLeitura;
        const keepFormats = group.formatosLidos;
        Object.assign(group, item);
        group.votosLeitura = keepVotes;
        group.origensLeitura = keepOrigins;
        group.formatosLidos = keepFormats;
        group.melhorScoreIndividual = Number(item.score || 0);
      }
      group.vinculoRemetente = group.vinculoRemetente || !!item.vinculoRemetente;
      group.transportadora = group.transportadora || item.transportadora || '';
      group.rastreioForte = group.rastreioForte || !!item.rastreioForte;
    }

    return [...groups.values()].map(group => {
      const consensusBonus = Math.max(0, group.votosLeitura - 1) * 22;
      const sourceBonus = Math.max(0, group.origensLeitura.length - 1) * 5;
      const remitenteBonus = group.vinculoRemetente ? 35 : 0;
      return {
        ...group,
        score: Number(group.melhorScoreIndividual || 0) + consensusBonus + sourceBonus + remitenteBonus
      };
    });
  }

  function choose(candidates) {
    const aggregated = aggregateCandidates(candidates).sort((a, b) =>
      Number(!!b.vinculoRemetente) - Number(!!a.vinculoRemetente)
      || Number(b.score || 0) - Number(a.score || 0)
      || Number(b.votosLeitura || 0) - Number(a.votosLeitura || 0)
      || Number(b.legibilidade || 0) - Number(a.legibilidade || 0)
      || String(b.codigo || '').length - String(a.codigo || '').length
    );
    const best = aggregated[0] || null;
    if (!best) return null;
    best.criterioEscolha = best.transportadora
      ? 'codigo-remetente-transportadora'
      : best.vinculoRemetente
        ? 'codigo-rastreio-remetente'
        : 'codigo-mais-legivel';
    best.alternativasDetectadas = aggregated.slice(1).map(item => ({
      codigo: item.codigo,
      formato: item.formato,
      score: item.score,
      votosLeitura: item.votosLeitura,
      vinculoRemetente: !!item.vinculoRemetente
    }));
    return best;
  }

  function loadImage(dataUrl, host) {
    return new Promise((resolve, reject) => {
      if (!host || typeof host.Image !== 'function') return reject(new Error('Image indisponível'));
      const image = new host.Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Imagem inválida para barcode/QR'));
      image.src = dataUrl;
    });
  }

  function nativeReadability(item, image) {
    const box = item?.boundingBox;
    const imageArea = Number(image?.naturalWidth || image?.width || 0) * Number(image?.naturalHeight || image?.height || 0);
    const boxArea = Number(box?.width || 0) * Number(box?.height || 0);
    if (imageArea > 0 && boxArea > 0) {
      const ratio = boxArea / imageArea;
      return clamp(10 + ratio * 220, 10, 35);
    }
    return 18;
  }

  async function nativeCandidates(imageData, host) {
    if (!host || typeof host.BarcodeDetector !== 'function') return [];
    let formats = FORMATS;
    try {
      if (typeof host.BarcodeDetector.getSupportedFormats === 'function') {
        const supported = await host.BarcodeDetector.getSupportedFormats();
        const allowed = new Set((supported || []).map(canonicalFormat));
        formats = FORMATS.filter(format => allowed.has(format));
      }
    } catch (_) {}
    if (!formats.length) return [];

    const image = await loadImage(imageData, host);
    const detector = new host.BarcodeDetector({ formats });
    const detections = await detector.detect(image);
    return (detections || []).map(item => candidate(item.rawValue, item.format, 'barcode/QR nativo', host, {
      readability: nativeReadability(item, image)
    })).filter(Boolean);
  }

  function zxingReadability(origin) {
    const value = String(origin || '').toLowerCase();
    if (/codigo-central|codigo-horizontal/.test(value)) return 28;
    if (/topo|meio|inferior/.test(value)) return 23;
    if (/etiqueta-inteira/.test(value)) return 15;
    if (/danfe/.test(value)) return 14;
    return 20;
  }

  async function zxingCandidates(imageData, host) {
    if (!host || !host.ZXing || typeof host.gerarVariacoesEtiqueta !== 'function') return [];
    if (typeof host.ZXing.MultiFormatReader !== 'function') return [];
    const reader = new host.ZXing.MultiFormatReader();
    const hints = new Map([[host.ZXing.DecodeHintType.TRY_HARDER, true]]);
    const results = [];
    const variants = await host.gerarVariacoesEtiqueta(imageData);

    for (const variant of variants || []) {
      const canvases = [variant.imagem];
      if (typeof host.canvasRotacionado === 'function') canvases.push(host.canvasRotacionado(variant.imagem, 90));
      for (const canvas of canvases.filter(Boolean)) {
        try {
          const ctx = canvas.getContext('2d');
          const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const gray = new Uint8ClampedArray(frame.width * frame.height);
          for (let i = 0; i < gray.length; i++) {
            gray[i] = (frame.data[i * 4] + 2 * frame.data[i * 4 + 1] + frame.data[i * 4 + 2]) / 4;
          }
          const bitmap = new host.ZXing.BinaryBitmap(new host.ZXing.HybridBinarizer(new host.ZXing.RGBLuminanceSource(gray, frame.width, frame.height)));
          const decoded = reader.decode(bitmap, hints);
          const raw = decoded.getText();
          const formatNumber = decoded.getBarcodeFormat();
          const format = canonicalFormat(host.ZXing.BarcodeFormat[formatNumber] || formatNumber);
          const origin = 'barcode/QR ZXing ' + String(variant.origem || 'imagem');
          const item = candidate(raw, format, origin, host, { readability: zxingReadability(origin) });
          if (item) results.push(item);
        } catch (_) {
        } finally {
          try { if (typeof reader.reset === 'function') reader.reset(); } catch (_) {}
        }
      }
    }
    return results;
  }

  async function scan(imageData, host, legacyReader) {
    host = host || root;
    const found = [];
    try { found.push(...await nativeCandidates(imageData, host)); } catch (_) {}
    try { found.push(...await zxingCandidates(imageData, host)); } catch (_) {}
    const best = choose(found);
    if (best) return best;

    if (typeof legacyReader === 'function') {
      try {
        const legacy = await legacyReader.call(host, imageData);
        if (legacy && legacy.codigo) {
          return {
            ...legacy,
            tipo: legacy.tipo || 'barcode',
            origem: legacy.origem || 'barcode/QR compatibilidade',
            leitorSeparado: true,
            legado: true,
            criterioEscolha: 'fallback-compatibilidade'
          };
        }
      } catch (_) {}
    }
    return null;
  }

  function installNormalizationFix(host) {
    host = host || root;
    if (!host) return false;

    if (typeof host.normalizarCodigoBarras === 'function' && !host.normalizarCodigoBarras.__preserveTrackingSuffix) {
      const originalNormalize = host.normalizarCodigoBarras;
      const wrappedNormalize = function(value) {
        const exact = exactTrackingToken(value);
        if (exact) return exact;
        const normalized = originalNormalize.call(this, value);
        return restoreTrailingSuffix(value, normalized);
      };
      wrappedNormalize.__preserveTrackingSuffix = true;
      wrappedNormalize.__original = originalNormalize;
      host.normalizarCodigoBarras = wrappedNormalize;
    }

    if (typeof host.extrairCodigoEtiquetaOCR === 'function' && !host.extrairCodigoEtiquetaOCR.__preserveTrackingSuffix) {
      const originalExtract = host.extrairCodigoEtiquetaOCR;
      const wrappedExtract = function(text) {
        const normalized = originalExtract.call(this, text);
        return restoreTrailingSuffix(text, normalized);
      };
      wrappedExtract.__preserveTrackingSuffix = true;
      wrappedExtract.__original = originalExtract;
      host.extrairCodigoEtiquetaOCR = wrappedExtract;
    }
    return true;
  }

  function loadReviewUi(host) {
    host = host || root;
    const doc = host?.document;
    if (!doc || typeof doc.createElement !== 'function') return false;
    if (host.RecipientReviewUI) {
      if (typeof host.RecipientReviewUI.install === 'function') host.RecipientReviewUI.install(host);
      return true;
    }
    if (doc.querySelector && doc.querySelector('script[data-recipient-review-ui="1"]')) return true;
    const script = doc.createElement('script');
    script.src = '/recipient-review-ui.js?v=20260902-1';
    script.async = true;
    script.dataset.recipientReviewUi = '1';
    script.onload = function() {
      if (host.RecipientReviewUI && typeof host.RecipientReviewUI.install === 'function') host.RecipientReviewUI.install(host);
    };
    (doc.head || doc.documentElement).appendChild(script);
    return true;
  }

  function install(host) {
    host = host || root;
    loadReviewUi(host);
    installNormalizationFix(host);
    if (!host || host.__separateBarcodeReaderInstalled) return !!host;
    if (typeof host.detectarCodigoLivre !== 'function') return false;
    const legacyReader = host.detectarCodigoLivre;
    const wrapped = async function(imageData) {
      const status = host.document?.getElementById?.('ocrStatus');
      if (status) status.textContent = '⏳ Lendo códigos da etiqueta e escolhendo o código da encomenda...';
      const result = await scan(imageData, host, legacyReader);
      if (status && result) {
        status.textContent = result.criterioEscolha === 'codigo-mais-legivel'
          ? '✅ Código da encomenda escolhido pela melhor legibilidade.'
          : '✅ Código de rastreio do remetente/transportadora identificado.';
      }
      return result;
    };
    wrapped.__separateBarcodeReader = true;
    wrapped.__legacy = legacyReader;
    host.detectarCodigoLivre = wrapped;
    host.__separateBarcodeReaderInstalled = true;
    host.BarcodeReaderRuntime = {
      scan: imageData => scan(imageData, host, legacyReader),
      version: '2026-09-02.5'
    };
    return true;
  }

  return {
    FORMATS,
    STRUCTURED_KEYS,
    canonicalFormat,
    typeForFormat,
    exactTrackingToken,
    restoreTrailingSuffix,
    looksLikeTracking,
    strongTrackingPattern,
    extractPayload,
    normalizeCode,
    carrierForCode,
    structuredTrackingPayload,
    score,
    candidate,
    aggregateCandidates,
    choose,
    nativeCandidates,
    zxingCandidates,
    scan,
    installNormalizationFix,
    loadReviewUi,
    install,
    version: '2026-09-02.5'
  };
});