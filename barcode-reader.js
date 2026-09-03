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

  function looksLikeTracking(value) {
    const text = String(value || '').trim().replace(/\s+/g, '');
    if (!text || text.length < 6 || text.length > 64) return false;
    if (/^(?:TBR|TBA)\d{8,}$/i.test(text)) return true;
    if (/^[A-Z]{2}\d{9}BR$/i.test(text)) return true;
    if (/^BR\d{8,}$/i.test(text)) return true;
    if (/^\d{8,40}$/.test(text)) return true;
    return /^[A-Z0-9][A-Z0-9._-]{5,63}$/i.test(text) && /\d/.test(text);
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
    let value = payload;
    try {
      if (host && typeof host.normalizarCodigoBarras === 'function') value = host.normalizarCodigoBarras(payload);
    } catch (_) {}
    value = String(value || '').trim().replace(/\s+/g, '');
    if (!looksLikeTracking(value)) return '';
    return value;
  }

  function score(raw, format, origin, host) {
    let value = 0;
    try {
      if (host && typeof host.pontuarCodigoBarras === 'function') {
        const external = Number(host.pontuarCodigoBarras(raw, canonicalFormat(format), origin));
        if (Number.isFinite(external)) value = external;
      }
    } catch (_) {}
    if (looksLikeTracking(extractPayload(raw, format))) value += 40;
    if (typeForFormat(format) === 'qr') value += 8;
    if (/nativo/i.test(origin)) value += 4;
    return value;
  }

  function candidate(raw, format, origin, host) {
    const codigo = normalizeCode(raw, format, host);
    if (!codigo) return null;
    return {
      codigo,
      raw: String(raw || ''),
      formato: canonicalFormat(format) || 'unknown',
      tipo: typeForFormat(format),
      origem: origin,
      score: score(raw, format, origin, host),
      leitorSeparado: true
    };
  }

  function choose(candidates) {
    return (candidates || []).filter(Boolean).sort((a, b) =>
      Number(b.score || 0) - Number(a.score || 0) || String(b.codigo || '').length - String(a.codigo || '').length
    )[0] || null;
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
    return (detections || []).map(item => candidate(item.rawValue, item.format, 'barcode/QR nativo', host)).filter(Boolean);
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
          const item = candidate(raw, format, 'barcode/QR ZXing ' + String(variant.origem || 'imagem'), host);
          if (item) results.push(item);
        } catch (_) {
          // Uma região sem código decodificável é normal.
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
            legado: true
          };
        }
      } catch (_) {}
    }
    return null;
  }

  function install(host) {
    host = host || root;
    if (!host || host.__separateBarcodeReaderInstalled) return !!host;
    if (typeof host.detectarCodigoLivre !== 'function') return false;
    const legacyReader = host.detectarCodigoLivre;
    const wrapped = function(imageData) {
      return scan(imageData, host, legacyReader);
    };
    wrapped.__separateBarcodeReader = true;
    wrapped.__legacy = legacyReader;
    host.detectarCodigoLivre = wrapped;
    host.__separateBarcodeReaderInstalled = true;
    host.BarcodeReaderRuntime = {
      scan: imageData => scan(imageData, host, legacyReader),
      version: '2026-09-02.1'
    };
    return true;
  }

  return {
    FORMATS,
    STRUCTURED_KEYS,
    canonicalFormat,
    typeForFormat,
    looksLikeTracking,
    extractPayload,
    normalizeCode,
    candidate,
    choose,
    nativeCandidates,
    zxingCandidates,
    scan,
    install,
    version: '2026-09-02.1'
  };
});