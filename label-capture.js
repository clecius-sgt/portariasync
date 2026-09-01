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
      if (i % width && Math.abs(value - gray[i - 1]) > 30) edges++;
    }
    const mean = sum / gray.length;
    const contrast = Math.sqrt(Math.max(0, square / gray.length - mean * mean));
    const movement = previous?.length === gray.length ? motion / gray.length : Infinity;
    const detail = edges / gray.length;
    return { gray, mean, contrast, movement, detail,
      ready: mean > 45 && mean < 254 && contrast > 18 && detail > 0.018 && movement < 4.5 };
  }

  function looksLikeLabel(result) {
    if (!result || result.confidence < 65) return false;
    const text = String(result.text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const address = /\b(rua|r\.?|avenida|av\.?|alameda|travessa)\s+[^\n]{2,80}\d/i.test(text);
    const shipping = /\b(destinatario|recipient|entrega|cep|correios|shopee|amazon|jadlog|loggi)\b/i.test(text)
      || /\b(?:[A-Z]{2}\d{9}BR|TBR\d{8,}|BR\d{8,})\b/i.test(text);
    const name = lines.some(s => /^[a-z]+(?:[ '\-]+[a-z]+){1,7}$/i.test(s));
    return lines.length >= 2 && text.length >= 25 && address && (name || shipping);
  }

  // Dependency injection keeps camera timing and cancellation testable without hardware.
  function create({ sample, snapshot, recognize, onCapture, onStatus = () => {},
    formatError = error => String(error?.message || error || 'Erro sem descrição').slice(0, 400),
    now = () => Date.now(), schedule = setTimeout, unschedule = clearTimeout, stableMs = 1200 }) {
    let stopped = false, timer, previous, stableSince = null, generation = 0;
    let busy = false, retryAt = 0, failure = false;

    function stop() {
      stopped = true;
      generation++;
      if (timer != null) unschedule(timer);
    }

    async function probe(version) {
      busy = true;
      try {
        const image = snapshot();
        onStatus('Conferindo o texto. Mantenha a etiqueta parada...');
        const result = await recognize(image, text => {
          if (!stopped) onStatus(text);
        });
        if (stopped || version !== generation) return;
        if (!looksLikeLabel(result)) {
          onStatus('Aproxime a etiqueta, com nome e endereço visíveis e texto na posição correta.');
          retryAt = now() + 2500;
          return;
        }
        stop(); // Latch before handing off: exactly one capture per camera session.
        onCapture(image, result);
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
            if (!busy && !failure && now() >= retryAt) onStatus(m.mean <= 45 ? 'Melhore a iluminação.' : 'Enquadre a etiqueta inteira e mantenha o aparelho parado.');
          } else {
            if (stableSince === null) stableSince = now();
            if (!busy && !failure && now() >= retryAt && now() - stableSince >= stableMs) void probe(generation);
          }
        }
      } catch (error) {
        stop();
        onStatus('Não foi possível analisar a câmera. Use Capturar agora.');
      }
      if (!stopped) timer = schedule(tick, 180);
    }
    timer = schedule(tick, 180);
    return { stop };
  }

  const api = { measure, looksLikeLabel, create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LabelCapture = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
