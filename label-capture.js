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

  // OCR de etiquetas reais pode produzir bastante texto útil sem conseguir reconstruir
  // perfeitamente nome/endereço. Nesse caso a fotografia deve ser concluída, e a etapa
  // seguinte faz a conferência conservadora do destinatário, em vez de reiniciar OCR sem fim.
  function usableLabelRead(result) {
    if (!result) return false;
    const text = String(result.text || '').trim();
    if (looksLikeLabel(result)) return true;
    if (text.length < 45) return false;
    const letters = (text.match(/[A-Za-zÀ-ÿ]/g) || []).length;
    const digits = (text.match(/\d/g) || []).length;
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).length;
    const logistic = /\b(entrega|tentativa|order|id|cep|brazil|brasil|kg|liquid|remetente|destinatario)\b/i.test(text)
      || /\b\d{5}[ -]?\d{3}\b/.test(text)
      || /\b[A-Z0-9]{9,}\b/i.test(text);
    return lines >= 4 && letters >= 15 && digits >= 5 && logistic;
  }

  function create({ sample, snapshot, recognize, onCapture, onStatus = () => {},
    formatError = error => String(error?.message || error || 'Erro sem descrição').slice(0, 400),
    now = () => Date.now(), schedule = setTimeout, unschedule = clearTimeout, stableMs = 700 }) {
    let stopped = false, timer, previous, stableSince = null, generation = 0;
    let busy = false, retryAt = 0, failure = false, attempts = 0;

    function stop() {
      stopped = true;
      generation++;
      if (timer != null) unschedule(timer);
    }

    async function probe(version) {
      busy = true;
      attempts++;
      try {
        const image = snapshot();
        onStatus('Etiqueta estável. Lendo automaticamente...');
        const result = await recognize(image, text => {
          if (!stopped) onStatus(text);
        });
        if (stopped || version !== generation) return;

        if (usableLabelRead(result)) {
          stop();
          result.autoCaptureUncertain = !looksLikeLabel(result);
          onStatus(result.autoCaptureUncertain
            ? 'Imagem capturada. A leitura precisa de conferência do destinatário.'
            : 'Etiqueta capturada automaticamente. Conferindo destinatário...');
          onCapture(image, result);
          return;
        }

        if (attempts >= 2) {
          stop();
          onStatus('Não consegui validar a etiqueta automaticamente. Use Capturar agora uma única vez.');
          return;
        }
        onStatus('Aproxime a etiqueta e mantenha-a parada para uma segunda tentativa automática.');
        retryAt = now() + 1000;
        stableSince = null;
      } catch (error) {
        if (!stopped) {
          failure = true;
          onStatus('Leitura automática indisponível. ' + formatError(error));
        }
      } finally {
        busy = false;
      }
    }

    function tick() {
      if (stopped) return;
      try {
        const frame = sample();
        if (!frame) { stableSince = null; previous = null; generation++; }
        else {
          const m = measure(frame.data, frame.width, frame.height, previous);
          previous = m.gray;
          if (!m.ready) {
            stableSince = null;
            generation++;
            if (!busy && !failure && now() >= retryAt) {
              onStatus(m.mean <= 38 ? 'Melhore a iluminação.' : 'Enquadre a etiqueta inteira e mantenha o aparelho parado por um instante.');
            }
          } else {
            if (stableSince === null) stableSince = now();
            if (!busy && !failure && now() >= retryAt && now() - stableSince >= stableMs) void probe(generation);
          }
        }
      } catch (error) {
        stop();
        onStatus('Não foi possível analisar a câmera. Use Capturar agora.');
      }
      if (!stopped) timer = schedule(tick, 160);
    }

    timer = schedule(tick, 160);
    return { stop };
  }

  const api = { measure, looksLikeLabel, usableLabelRead, create, version: '2026-09-01.6' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LabelCapture = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
