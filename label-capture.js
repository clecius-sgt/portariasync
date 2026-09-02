(function(root) {
  'use strict';

  function measure(data, width, height, previous) {
    const gray = new Uint8Array(width * height);
    let sum = 0, square = 0, motion = 0, edges = 0;
    for (let i = 0; i < gray.length; i++) {
      const p = i * 4;
      const value = Math.round(data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114);
      gray[i] = value;
      sum += value;
      square += value * value;
      if (previous?.length === gray.length) motion += Math.abs(value - previous[i]);
      if (i % width && Math.abs(value - gray[i - 1]) > 26) edges++;
    }
    const mean = sum / gray.length;
    const contrast = Math.sqrt(Math.max(0, square / gray.length - mean * mean));
    const movement = previous?.length === gray.length ? motion / gray.length : Infinity;
    const detail = edges / gray.length;
    const ready = mean > 38 && mean < 252 && contrast > 13 && detail > 0.010 && movement < 7.5;
    return { gray, mean, contrast, movement, detail, ready };
  }

  function looksLikeLabel(result) {
    if (!result || result.confidence < 50) return false;
    const text = String(result.text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const address = /\b(rua|r\.?|rva|avenida|av\.?|alameda|travessa)\s+[^\n]{2,80}(?:\d|[il]\d|\d[oO])/i.test(text);
    const tracking = /\b(?:[A-Z]{2}\d{9}BR|TBR\d{8,}|TBA\d{8,}|BR\d{8,})\b/i.test(text);
    const shippingWord = /\b(destinatario|recipient|entrega|cep|correios|shopee|amazon|jadlog|loggi|order|tentativa)\b/i.test(text);
    const cep = /\b(?:cep\s*)?\d{5}[- ]?\d{3}\b/i.test(text);
    const name = lines.some(s => /^[a-z]+(?:[ '\-]+[a-z]+){1,7}$/i.test(s));
    const readableAddress = lines.length >= 2 && text.length >= 25 && address && (name || shippingWord || tracking);
    const strongShippingLabel = lines.length >= 3 && text.length >= 35 && tracking && (shippingWord || cep || /\d/.test(text));
    return readableAddress || strongShippingLabel;
  }

  function updateManualCaptureUi(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;

    const modal = doc.getElementById('modalUnificado');
    if (modal && modal.firstElementChild) {
      const title = String(modal.firstElementChild.textContent || '');
      if (/captura\s+(?:e|é)\s+autom[aá]tica/i.test(title)) {
        modal.firstElementChild.textContent = '📷 Use a câmera do celular e fotografe a etiqueta inteira.';
      }
    }

    if (doc.querySelectorAll) {
      doc.querySelectorAll('button').forEach(button => {
        const text = String(button.textContent || '').trim();
        if (/Ler etiqueta com captura autom[aá]tica/i.test(text)) button.textContent = '📷 Fotografar etiqueta';
        else if (/Capturar agora/i.test(text)) button.textContent = '📸 Fotografar etiqueta';
      });
    }
  }

  function triggerNativePhotoInput(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc) return false;
    const input = doc.getElementById('inputFotoOCR');
    if (!input || typeof input.click !== 'function') return false;
    input.value = '';
    input.click();
    return true;
  }

  function installNativePhotoMode(doc, host) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    host = host || root;
    if (!doc || !host) return false;
    updateManualCaptureUi(doc);
    const input = doc.getElementById('inputFotoOCR');
    if (!input) return false;

    host.fotografarEtiqueta = function() {
      try {
        if (typeof host.fecharCameraUnificada === 'function') host.fecharCameraUnificada();
      } catch (_) {}
      return triggerNativePhotoInput(doc);
    };
    return true;
  }

  async function recognizeWithPaddle(imgBase64, statusEl, host) {
    host = host || root;
    if (!host || typeof host.fetch !== 'function') throw new Error('Navegador sem suporte ao leitor do servidor.');
    const storage = host.localStorage;
    const token = storage && typeof storage.getItem === 'function' ? (storage.getItem('authToken') || '') : '';
    const apiBase = storage && typeof storage.getItem === 'function' ? (storage.getItem('apiBaseUrl') || '') : '';
    if (!token) throw new Error('Sessão expirada. Entre novamente no sistema.');
    if (statusEl) statusEl.textContent = 'Lendo a fotografia com PaddleOCR no servidor...';

    const response = await host.fetch(apiBase + '/api/ocr-paddle', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token
      },
      body: JSON.stringify({ imagemBase64: imgBase64 })
    });
    let payload = {};
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(payload.error || payload.detail || ('PaddleOCR respondeu ' + response.status));
    const result = payload.result || payload;
    if (!String(result.text || '').trim()) throw new Error('PaddleOCR não encontrou texto legível na fotografia.');
    return {
      text: String(result.text || ''),
      confidence: Number(result.confidence || 0),
      lines: Array.isArray(result.lines) ? result.lines : [],
      engine: 'paddleocr'
    };
  }

  function installPaddleOcrMode(host) {
    host = host || root;
    if (!host || typeof host.enviarParaOCR !== 'function') return false;
    const original = host.enviarParaOCR;
    if (original.__paddleWrapped) return true;

    const wrapped = async function(imgBase64, statusEl, codigoJaLido = null, transpJaLida = '', leituraId, ocrResult = null) {
      if (ocrResult) {
        return original.call(this, imgBase64, statusEl, codigoJaLido, transpJaLida, leituraId, ocrResult);
      }
      try {
        const paddleResult = await recognizeWithPaddle(imgBase64, statusEl, host);
        if (statusEl) statusEl.textContent = 'PaddleOCR concluiu a leitura. Conferindo destinatário...';
        return original.call(this, imgBase64, statusEl, codigoJaLido, transpJaLida, leituraId, paddleResult);
      } catch (error) {
        console.warn('PaddleOCR indisponível, usando leitor local como contingência:', error);
        if (statusEl) statusEl.textContent = 'Leitor do servidor indisponível. Tentando leitor local...';
        return original.call(this, imgBase64, statusEl, codigoJaLido, transpJaLida, leituraId, null);
      }
    };
    wrapped.__paddleWrapped = true;
    wrapped.__original = original;
    host.enviarParaOCR = wrapped;
    return true;
  }

  // Modo manual: não há amostragem contínua, fotografia automática nem OCR em tempo real.
  function create({ onStatus = () => {} } = {}) {
    let stopped = false;
    updateManualCaptureUi();
    onStatus('Use Fotografar etiqueta, enquadre toda a etiqueta e confirme uma única foto.');
    return {
      stop() { stopped = true; },
      get stopped() { return stopped; }
    };
  }

  if (typeof document !== 'undefined') {
    const install = () => {
      installNativePhotoMode(document, root);
      installPaddleOcrMode(root);
    };
    if (document.readyState === 'loading' && document.addEventListener) {
      document.addEventListener('DOMContentLoaded', install, { once: true });
    } else install();
  }

  const api = {
    measure,
    looksLikeLabel,
    create,
    updateManualCaptureUi,
    triggerNativePhotoInput,
    installNativePhotoMode,
    recognizeWithPaddle,
    installPaddleOcrMode,
    automaticCapture: false,
    nativePhotoCapture: true,
    paddleOCRServer: true,
    version: '2026-09-02.2'
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LabelCapture = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
