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

  function updateManualCaptureUi() {
    if (typeof document === 'undefined') return;

    const modal = document.getElementById('modalUnificado');
    if (modal && modal.firstElementChild) {
      const title = String(modal.firstElementChild.textContent || '');
      if (/captura\s+(?:e|é)\s+autom[aá]tica/i.test(title)) {
        modal.firstElementChild.textContent = '📷 Enquadre a etiqueta inteira, aguarde o foco e fotografe.';
      }
    }

    if (document.querySelectorAll) {
      document.querySelectorAll('button').forEach(button => {
        const text = String(button.textContent || '').trim();
        if (/Ler etiqueta com captura autom[aá]tica/i.test(text)) button.textContent = '📷 Fotografar etiqueta';
        else if (/Capturar agora/i.test(text)) button.textContent = '📸 Fotografar etiqueta';
      });
    }
  }

  // Modo manual: testes em aparelhos reais mostraram que autofocus e exposição variáveis
  // tornam a seleção automática do quadro menos consistente que uma foto deliberada.
  // A API create é preservada para compatibilidade com index.html, mas não amostra a câmera,
  // não tira fotos e não chama OCR. O operador congela um único quadro e só então o OCR lê.
  function create({ onStatus = () => {} } = {}) {
    let stopped = false;
    updateManualCaptureUi();
    onStatus('Enquadre a etiqueta inteira, aguarde o foco e toque em Fotografar etiqueta.');
    return {
      stop() { stopped = true; },
      get stopped() { return stopped; }
    };
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading' && document.addEventListener) {
      document.addEventListener('DOMContentLoaded', updateManualCaptureUi, { once: true });
    } else updateManualCaptureUi();
  }

  const api = { measure, looksLikeLabel, create, updateManualCaptureUi, automaticCapture: false, version: '2026-09-01.7' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LabelCapture = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
