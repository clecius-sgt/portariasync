(function(root) {
  'use strict';
  let workerPromise = null;
  let queue = Promise.resolve();
  let progress = null;
  let phase = 'inicialização';

  function formatError(error) {
    const detail = String(error?.message || error || 'Erro sem descrição').slice(0, 400);
    return 'Falha no leitor (' + (error?.ocrPhase || phase) + '): ' + detail;
  }

  function getWorker() {
    if (!workerPromise) {
      if (!root.Tesseract) throw new Error('Leitor local ausente. Execute npm ci no servidor.');
      phase = 'inicialização';
      workerPromise = root.Tesseract.createWorker('por', 1, {
        workerPath: '/vendor/ocr/worker.min.js',
        corePath: '/vendor/ocr/core',
        langPath: '/vendor/ocr/lang',
        workerBlobURL: false,
        logger: event => { if (progress) progress(event); },
        errorHandler: () => {}
      }).then(async worker => {
        try {
          await worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
        } catch (error) {
          await worker.terminate();
          throw error;
        }
        return worker;
      });
    }
    return workerPromise;
  }

  function enqueue(task, onProgress) {
    const job = queue.then(async () => {
      progress = onProgress;
      let timer;
      try {
        const result = await Promise.race([
          task(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Tempo de leitura excedido. Confira a conexão e tente novamente.')), 60000);
          })
        ]);
        return result;
      } catch (error) {
        const failed = workerPromise;
        workerPromise = null;
        if (failed) failed.then(w => w.terminate()).catch(() => {});
        const failure = new Error(String(error?.message || error || 'Erro sem descrição'));
        failure.ocrPhase = phase;
        throw failure;
      } finally {
        clearTimeout(timer);
        progress = null;
      }
    });
    queue = job.catch(() => {});
    return job;
  }

  function prepare(onProgress) {
    return enqueue(async () => { await getWorker(); }, onProgress);
  }

  function normalizeLine(line) {
    return String(line || '').replace(/\s+/g, ' ').trim();
  }

  function mergeTexts(a, b) {
    const seen = new Set();
    const lines = [];
    for (const line of (String(a || '') + '\n' + String(b || '')).split(/\r?\n/)) {
      const clean = normalizeLine(line);
      if (!clean) continue;
      const key = clean.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(clean);
    }
    return lines.join('\n');
  }

  function needsDetailPass(text, confidence) {
    const value = String(text || '');
    const hasAddress = /\b(rua|r\.?|rva|avenida|av\.?|alameda|travessa)\s+[^\n]{2,70}(?:\d|[il]\d|\d[oO])/i.test(value);
    const hasTracking = /\b(?:TBR\d{8,}|TBA\d{8,}|[A-Z]{2}\d{9}BR|BR\d{8,})\b/i.test(value);
    const hasRecipientLikeName = value.split(/\r?\n/).some(line => /^[A-Za-zÀ-ÿ]+(?:[ '\-]+[A-Za-zÀ-ÿ]+){1,6}$/.test(line.trim()));
    return confidence < 78 || !hasAddress || !(hasRecipientLikeName || hasTracking);
  }

  async function recognizePass(worker, image, pageSegMode) {
    await worker.setParameters({ tessedit_pageseg_mode: String(pageSegMode), preserve_interword_spaces: '1' });
    const result = await worker.recognize(image, { rotateAuto: true });
    return { text: String(result.data.text || '').trim(), confidence: Number(result.data.confidence) || 0 };
  }

  function recognize(image, onProgress) {
    return enqueue(async () => {
      const worker = await getWorker();
      phase = 'leitura da imagem';

      // PSM 3 works well for a complete label. If it misses the small recipient/address
      // block, PSM 6 performs a second pass treating the label as a text block.
      const first = await recognizePass(worker, image, 3);
      if (!needsDetailPass(first.text, first.confidence)) return first;

      if (progress) progress({ status: 'recognizing text detail', progress: 0 });
      const second = await recognizePass(worker, image, 6);
      const text = mergeTexts(first.text, second.text);
      const confidence = Math.max(first.confidence, second.confidence);

      // Restore the default for the next label. The queue guarantees there is no overlap.
      await worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
      return { text, confidence };
    }, onProgress);
  }

  function progressText(event) {
    const labels = {
      'loading tesseract core': 'Carregando o motor de leitura',
      'initializing tesseract': 'Iniciando o motor de leitura',
      'loading language traineddata': 'Carregando o idioma português',
      'initializing api': 'Preparando o leitor',
      'recognizing text': 'Lendo o texto da etiqueta',
      'recognizing text detail': 'Conferindo nome e endereço em detalhe'
    };
    const label = labels[event?.status] || 'Preparando o leitor local';
    const percent = Number.isFinite(event?.progress) ? ' (' + Math.round(event.progress * 100) + '%)' : '';
    return label + percent + '...';
  }

  root.LocalOCR = { recognize, prepare, formatError, progressText, needsDetailPass, mergeTexts, version: '2026-09-01.3' };
})(globalThis);
